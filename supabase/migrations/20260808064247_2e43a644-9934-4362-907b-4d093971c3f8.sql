-- 1) Pause state on the advance
ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS deduction_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_by uuid,
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS resumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resumed_by uuid;

CREATE INDEX IF NOT EXISTS idx_agent_advances_deduction_paused
  ON public.agent_advances (deduction_paused) WHERE deduction_paused = true;

-- 2) Pause / resume event log
CREATE TABLE IF NOT EXISTS public.agent_advance_pause_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.agent_advances(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('paused', 'resumed')),
  reason text NOT NULL,
  acted_by uuid NOT NULL,
  outstanding_at_action numeric NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agent_advance_pause_events TO authenticated;
GRANT ALL ON public.agent_advance_pause_events TO service_role;

ALTER TABLE public.agent_advance_pause_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops and exec can view advance pause events"
ON public.agent_advance_pause_events FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE POLICY "Agents can view pause events on their own advances"
ON public.agent_advance_pause_events FOR SELECT TO authenticated
USING (agent_id = auth.uid());

CREATE TRIGGER trg_agent_advance_pause_events_updated_at
BEFORE UPDATE ON public.agent_advance_pause_events
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3) Authorization helper
CREATE OR REPLACE FUNCTION public.can_pause_agent_advance(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND (
    public.has_role(_user_id, 'cfo')
    OR public.has_role(_user_id, 'agent_ops')
    OR public.has_role(_user_id, 'manager')
    OR public.has_role(_user_id, 'coo')
    OR public.has_role(_user_id, 'ceo')
    OR public.has_role(_user_id, 'super_admin')
  )
$$;

-- 4) Pause
CREATE OR REPLACE FUNCTION public.pause_agent_advance(p_advance_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_adv   record;
  v_event uuid;
BEGIN
  IF NOT public.can_pause_agent_advance(v_actor) THEN
    RAISE EXCEPTION 'Not authorised to pause advance deductions';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF v_adv.id IS NULL THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;
  IF v_adv.status NOT IN ('active', 'overdue') THEN
    RAISE EXCEPTION 'Only active or overdue advances can be paused (current status: %)', v_adv.status;
  END IF;
  IF COALESCE(v_adv.deduction_paused, false) THEN
    RAISE EXCEPTION 'Deductions are already paused on this advance';
  END IF;

  UPDATE public.agent_advances
  SET deduction_paused = true,
      paused_at = now(),
      paused_by = v_actor,
      pause_reason = btrim(p_reason),
      resumed_at = NULL,
      resumed_by = NULL,
      updated_at = now()
  WHERE id = p_advance_id;

  INSERT INTO public.agent_advance_pause_events
    (advance_id, agent_id, action, reason, acted_by, outstanding_at_action, metadata)
  VALUES
    (p_advance_id, v_adv.agent_id, 'paused', btrim(p_reason), v_actor,
     COALESCE(v_adv.outstanding_balance, 0),
     jsonb_build_object('status_at_action', v_adv.status,
                        'arrears_at_action', COALESCE(v_adv.arrears_balance, 0)))
  RETURNING id INTO v_event;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_actor, 'advance_deduction_paused', 'agent_advances', p_advance_id, btrim(p_reason),
            jsonb_build_object('agent_id', v_adv.agent_id,
                               'outstanding_balance', COALESCE(v_adv.outstanding_balance, 0),
                               'pause_event_id', v_event));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('repayment_paused', v_adv.agent_id, 'agent_advance', p_advance_id,
            jsonb_build_object('paused_by', v_actor, 'reason', btrim(p_reason)));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'advance_id', p_advance_id,
                            'deduction_paused', true, 'pause_event_id', v_event);
END;
$$;

-- 5) Resume
CREATE OR REPLACE FUNCTION public.resume_agent_advance(p_advance_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_adv   record;
  v_event uuid;
BEGIN
  IF NOT public.can_pause_agent_advance(v_actor) THEN
    RAISE EXCEPTION 'Not authorised to resume advance deductions';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF v_adv.id IS NULL THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;
  IF NOT COALESCE(v_adv.deduction_paused, false) THEN
    RAISE EXCEPTION 'Deductions are not paused on this advance';
  END IF;

  UPDATE public.agent_advances
  SET deduction_paused = false,
      resumed_at = now(),
      resumed_by = v_actor,
      updated_at = now()
  WHERE id = p_advance_id;

  INSERT INTO public.agent_advance_pause_events
    (advance_id, agent_id, action, reason, acted_by, outstanding_at_action, metadata)
  VALUES
    (p_advance_id, v_adv.agent_id, 'resumed', btrim(p_reason), v_actor,
     COALESCE(v_adv.outstanding_balance, 0),
     jsonb_build_object('paused_at', v_adv.paused_at, 'original_pause_reason', v_adv.pause_reason))
  RETURNING id INTO v_event;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_actor, 'advance_deduction_resumed', 'agent_advances', p_advance_id, btrim(p_reason),
            jsonb_build_object('agent_id', v_adv.agent_id,
                               'paused_at', v_adv.paused_at,
                               'pause_event_id', v_event));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('repayment_resumed', v_adv.agent_id, 'agent_advance', p_advance_id,
            jsonb_build_object('resumed_by', v_actor, 'reason', btrim(p_reason)));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'advance_id', p_advance_id, 'deduction_paused', false,
                            'pause_event_id', v_event);
END;
$$;

REVOKE ALL ON FUNCTION public.pause_agent_advance(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resume_agent_advance(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pause_agent_advance(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_agent_advance(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_pause_agent_advance(uuid) TO authenticated, service_role;

-- 6) Every automatic recovery path must skip paused advances
CREATE OR REPLACE FUNCTION public.sweep_agent_advance_recovery()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent record; v_adv record;
  v_avail numeric; v_deduct numeric; v_closing numeric;
  v_total_payable numeric; v_total_deducted numeric;
  v_fee_ratio numeric; v_new_fee numeric; v_fee_status text; v_new_status text;
  v_recovered_total numeric := 0; v_agents_touched int := 0; v_idem text;
  v_installment numeric; v_paid_today numeric; v_room numeric;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_row_exists boolean;
  v_agent_recovered numeric;
  v_period_days int; v_anchor date; v_expected_to_date numeric; v_paid_to_date numeric;
BEGIN
  FOR v_agent IN
    SELECT DISTINCT agent_id FROM public.agent_advances
    WHERE status IN ('active','overdue') AND COALESCE(deduction_paused, false) = false AND outstanding_balance > 0
      AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
  LOOP
    v_avail := COALESCE(public.get_agent_sweepable_withdrawable(v_agent.agent_id), 0);
    v_agent_recovered := 0;

    FOR v_adv IN
      SELECT * FROM public.agent_advances
      WHERE agent_id = v_agent.agent_id
        AND status IN ('active','overdue') AND COALESCE(deduction_paused, false) = false AND outstanding_balance > 0
        AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
      ORDER BY issued_at ASC
    LOOP
      SELECT EXISTS (
        SELECT 1 FROM public.agent_advance_ledger
        WHERE advance_id = v_adv.id AND date = v_today
      ) INTO v_row_exists;
      IF v_row_exists THEN CONTINUE; END IF;

      IF COALESCE(v_adv.prepaid_installments_remaining, 0) > 0 THEN
        UPDATE public.agent_advances
        SET prepaid_installments_remaining = prepaid_installments_remaining - 1, updated_at = now()
        WHERE id = v_adv.id;
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'prepaid');
        CONTINUE;
      END IF;

      v_period_days := public.advance_period_days(v_adv.repayment_frequency);

      IF v_period_days > 1 THEN
        SELECT max(date) INTO v_anchor
          FROM public.agent_advance_ledger
         WHERE advance_id = v_adv.id AND amount_deducted > 0;
        v_anchor := COALESCE(v_anchor, (v_adv.issued_at AT TIME ZONE 'Africa/Kampala')::date);
        IF (v_today - v_anchor) < v_period_days THEN
          INSERT INTO public.agent_advance_ledger
            (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
          VALUES
            (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'not_due');
          CONTINUE;
        END IF;
      END IF;

      v_total_payable := COALESCE(v_adv.principal,0) + COALESCE(v_adv.access_fee,0);
      v_installment := public.advance_installment_amount(
        v_adv.principal, v_adv.access_fee, v_adv.cycle_days,
        v_adv.repayment_frequency, v_adv.installment_amount
      );
      IF v_installment <= 0 THEN CONTINUE; END IF;

      v_expected_to_date := public.advance_expected_repaid_to_date(
        v_adv.issued_at, v_adv.principal, v_adv.access_fee, v_adv.cycle_days,
        v_adv.repayment_frequency, v_adv.installment_amount
      );
      v_paid_to_date := GREATEST(0, v_total_payable - COALESCE(v_adv.outstanding_balance, 0));

      IF v_paid_to_date >= v_expected_to_date THEN
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'ahead');
        CONTINUE;
      END IF;

      EXIT WHEN v_avail <= 0;

      SELECT COALESCE(SUM(amount_deducted), 0) INTO v_paid_today
        FROM public.agent_advance_ledger
       WHERE advance_id = v_adv.id AND date = v_today;

      v_room := GREATEST(0, (v_expected_to_date - v_paid_to_date) - v_paid_today);
      IF v_room <= 0 THEN CONTINUE; END IF;

      v_deduct := LEAST(v_avail, v_adv.outstanding_balance, v_room);
      IF v_deduct <= 0 THEN CONTINUE; END IF;

      v_idem := 'adv_recover_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

      PERFORM public.create_ledger_transaction(
        entries => jsonb_build_array(
          jsonb_build_object(
            'user_id', v_agent.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
            'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'user',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Automatic advance recovery from withdrawable balance', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','auto_withdrawable_sweep','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          ),
          jsonb_build_object(
            'user_id', v_agent.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
            'amount', v_deduct, 'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
            'source_table', 'agent_advances', 'source_id', v_adv.id,
            'description', 'Advance repayment received from agent (auto-sweep)', 'currency', 'UGX',
            'metadata', jsonb_build_object('source','auto_withdrawable_sweep','advance_id',v_adv.id,'bucket_intent','advance_balance_recovery')
          )
        ),
        idempotency_key => v_idem
      );

      v_closing := v_adv.outstanding_balance - v_deduct;
      v_new_status := CASE WHEN v_closing <= 0 THEN 'completed'
                           WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;
      v_total_deducted := v_total_payable - GREATEST(0, v_closing);
      v_fee_ratio := CASE WHEN v_total_payable > 0 THEN LEAST(1, v_total_deducted / v_total_payable) ELSE 0 END;
      v_new_fee := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
      v_fee_status := CASE WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
                           WHEN v_new_fee > 0 THEN 'partial' ELSE 'unpaid' END;

      UPDATE public.agent_advances
      SET outstanding_balance = GREATEST(0, v_closing), status = v_new_status,
          access_fee_collected = v_new_fee, access_fee_status = v_fee_status,
          arrears_balance = GREATEST(0, LEAST(
            GREATEST(0, v_closing),
            COALESCE(v_adv.arrears_balance, 0) + (v_installment - v_deduct)
          )),
          updated_at = now()
      WHERE id = v_adv.id;

      INSERT INTO public.agent_advance_ledger
        (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
      VALUES
        (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_deduct, GREATEST(0, v_closing),
         CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

      v_avail := v_avail - v_deduct;
      v_recovered_total := v_recovered_total + v_deduct;
      v_agent_recovered := v_agent_recovered + v_deduct;
    END LOOP;

    IF v_agent_recovered > 0 THEN
      BEGIN
        PERFORM net.http_post(
          url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-advance-deduction',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
          body := jsonb_build_object('agent_id', v_agent.agent_id, 'amount', v_agent_recovered, 'source', 'auto_withdrawable_sweep')
        );
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;

    v_agents_touched := v_agents_touched + 1;
  END LOOP;

  RETURN jsonb_build_object('agents_touched', v_agents_touched, 'recovered_total', v_recovered_total, 'ran_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_roi_advance_recovery(p_user_id uuid, p_roi_amount numeric, p_source_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_adv record;
  v_remaining numeric := COALESCE(p_roi_amount, 0);
  v_recovered numeric := 0;
  v_take numeric;
  v_closing numeric;
  v_new_status text;
  v_idem text;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_details jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL OR v_remaining <= 0 THEN
    RETURN jsonb_build_object('recovered', 0, 'net_roi', GREATEST(0, v_remaining), 'advances', v_details);
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE idempotency_key = 'roi_adv_rec_' || p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('recovered', 0, 'net_roi', v_remaining, 'advances', v_details, 'skipped', 'already_recovered');
  END IF;

  FOR v_adv IN
    SELECT * FROM public.agent_advances
    WHERE agent_id = p_user_id
      AND recovery_source = 'roi'
      AND status IN ('active','overdue') AND COALESCE(deduction_paused, false) = false
      AND outstanding_balance > 0
      AND COALESCE(roi_recovery_percent, 0) > 0
    ORDER BY issued_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_take := round(LEAST(
      v_adv.outstanding_balance,
      v_remaining,
      COALESCE(p_roi_amount, 0) * (v_adv.roi_recovery_percent / 100.0)
    ));
    IF v_take <= 0 THEN CONTINUE; END IF;

    v_idem := COALESCE(
      'roi_adv_rec_' || p_idempotency_key,
      'roi_adv_rec_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text
    );

    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_take, 'category', 'agent_repayment', 'recipient_type', 'user',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Advance recovery of ' || v_adv.roi_recovery_percent || '% from ROI payout',
          'currency', 'UGX',
          'metadata', jsonb_build_object('source','roi_recovery','advance_id',v_adv.id,'roi_amount',p_roi_amount,'portfolio_id',p_source_id)
        ),
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_take, 'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Advance repayment received from ROI recovery',
          'currency', 'UGX',
          'metadata', jsonb_build_object('source','roi_recovery','advance_id',v_adv.id,'roi_amount',p_roi_amount,'portfolio_id',p_source_id)
        )
      ),
      idempotency_key => v_idem
    );

    v_closing := GREATEST(0, v_adv.outstanding_balance - v_take);
    v_new_status := CASE WHEN v_closing <= 0 THEN 'completed'
                         WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;

    UPDATE public.agent_advances
    SET outstanding_balance = v_closing,
        status = v_new_status,
        updated_at = now()
    WHERE id = v_adv.id;

    INSERT INTO public.agent_advance_ledger
      (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance,
       deduction_status, recovery_source, roi_amount, recovery_percent)
    VALUES
      (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_take, v_closing,
       CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END,
       'roi', p_roi_amount, v_adv.roi_recovery_percent);

    v_remaining := v_remaining - v_take;
    v_recovered := v_recovered + v_take;
    v_details := v_details || jsonb_build_object(
      'advance_id', v_adv.id,
      'percent', v_adv.roi_recovery_percent,
      'recovered', v_take,
      'outstanding_after', v_closing,
      'status', v_new_status
    );
  END LOOP;

  RETURN jsonb_build_object(
    'recovered', v_recovered,
    'net_roi', GREATEST(0, COALESCE(p_roi_amount,0) - v_recovered),
    'advances', v_details
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.recover_agent_arrears_from_credit(p_agent_id uuid, p_credit_amount numeric, p_trigger_ledger_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_adv             record;
  v_available       numeric;
  v_budget          numeric;
  v_take            numeric;
  v_closing         numeric;
  v_new_status      text;
  v_total_payable   numeric;
  v_total_deducted  numeric;
  v_fee_ratio       numeric;
  v_new_fee         numeric;
  v_fee_status      text;
  v_recovered       numeric := 0;
  v_idem            text;
BEGIN
  IF p_agent_id IS NULL OR p_credit_amount IS NULL OR p_credit_amount <= 0 THEN
    RETURN 0;
  END IF;

  v_available := COALESCE(public.get_user_available_balance(p_agent_id), 0);
  IF v_available <= 0 THEN RETURN 0; END IF;

  v_budget := LEAST(p_credit_amount, v_available);
  IF v_budget <= 0 THEN RETURN 0; END IF;

  FOR v_adv IN
    SELECT *
    FROM public.agent_advances
    WHERE agent_id = p_agent_id
      AND status IN ('active', 'overdue') AND COALESCE(deduction_paused, false) = false
      AND arrears_balance > 0
      AND outstanding_balance > 0
      AND (issued_at AT TIME ZONE 'Africa/Kampala')::date
          < (now()      AT TIME ZONE 'Africa/Kampala')::date
    ORDER BY issued_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_budget <= 0;

    v_take := LEAST(v_budget, v_adv.arrears_balance, v_adv.outstanding_balance);
    IF v_take <= 0 THEN CONTINUE; END IF;

    v_idem := 'arrears_recover_' || v_adv.id::text || '_'
              || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_take, 'category', 'agent_repayment',
          'recipient_type', 'user',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Missed advance repayment auto-recovered from new earning',
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'arrears_credit_intercept',
            'advance_id', v_adv.id,
            'trigger_ledger_id', p_trigger_ledger_id,
            'bucket_intent', 'advance_balance_recovery'
          )
        ),
        jsonb_build_object(
          'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_take, 'category', 'agent_repayment',
          'recipient_type', 'operational_wallet',
          'source_table', 'agent_advances', 'source_id', v_adv.id,
          'description', 'Advance arrears repayment received from agent',
          'currency', 'UGX',
          'metadata', jsonb_build_object(
            'source', 'arrears_credit_intercept',
            'advance_id', v_adv.id,
            'trigger_ledger_id', p_trigger_ledger_id,
            'bucket_intent', 'advance_balance_recovery'
          )
        )
      ),
      idempotency_key => v_idem
    );

    v_closing := v_adv.outstanding_balance - v_take;
    v_new_status := CASE
      WHEN v_closing <= 0 THEN 'completed'
      WHEN v_adv.expires_at < now() THEN 'overdue'
      ELSE 'active'
    END;

    v_total_payable  := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
    v_total_deducted := v_total_payable - GREATEST(0, v_closing);
    v_fee_ratio := CASE WHEN v_total_payable > 0
                        THEN LEAST(1, v_total_deducted / v_total_payable)
                        ELSE 0 END;
    v_new_fee := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
    v_fee_status := CASE
      WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
      WHEN v_new_fee > 0 THEN 'partial'
      ELSE 'unpaid'
    END;

    UPDATE public.agent_advances
    SET outstanding_balance  = GREATEST(0, v_closing),
        arrears_balance      = GREATEST(0, LEAST(v_adv.arrears_balance - v_take, GREATEST(0, v_closing))),
        status               = v_new_status,
        access_fee_collected = v_new_fee,
        access_fee_status    = v_fee_status,
        updated_at           = now()
    WHERE id = v_adv.id;

    INSERT INTO public.agent_advance_ledger
      (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
    VALUES
      (v_adv.id, current_date, v_adv.outstanding_balance, 0, v_take, GREATEST(0, v_closing),
       CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

    v_budget    := v_budget - v_take;
    v_recovered := v_recovered + v_take;
  END LOOP;

  IF v_recovered > 0 THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      p_agent_id,
      'Advance repayment recovered',
      'UGX ' || to_char(v_recovered, 'FM999,999,990') ||
      ' from your latest earning was automatically applied to your missed advance repayment(s).',
      'advance_arrears',
      jsonb_build_object(
        'event', 'advance_arrears_recovered',
        'amount', v_recovered,
        'source', 'arrears_credit_intercept',
        'trigger_ledger_id', p_trigger_ledger_id,
        'send_push', true
      )
    );

    BEGIN
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, metadata)
      VALUES (
        'repayment_successful',
        p_agent_id,
        'agent_advance',
        jsonb_build_object(
          'source', 'arrears_credit_intercept',
          'amount', v_recovered,
          'trigger_ledger_id', p_trigger_ledger_id
        )
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN v_recovered;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_recover_advance_arrears_on_earning()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ledger_scope = 'wallet'
     AND NEW.direction IN ('cash_in', 'credit')
     AND NEW.user_id IS NOT NULL
     AND NEW.amount > 0
     AND COALESCE(NEW.classification, 'production') NOT IN ('admin_correction')
     AND NEW.category IN ('agent_commission_earned', 'agent_commission')
     AND (NEW.wallet_bucket = 'withdrawable' OR NEW.wallet_bucket IS NULL OR NEW.recipient_type = 'user')
  THEN
    IF EXISTS (
      SELECT 1 FROM public.agent_advances
      WHERE agent_id = NEW.user_id
        AND status IN ('active', 'overdue') AND COALESCE(deduction_paused, false) = false
        AND arrears_balance > 0
        AND outstanding_balance > 0
    ) THEN
      BEGIN
        PERFORM public.recover_agent_arrears_from_credit(NEW.user_id, NEW.amount, NEW.id);
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          INSERT INTO public.system_events (event_type, user_id, related_entity_type, metadata)
          VALUES (
            'repayment_failed',
            NEW.user_id,
            'agent_advance',
            jsonb_build_object(
              'source', 'arrears_credit_intercept',
              'trigger_ledger_id', NEW.id,
              'error', SQLERRM
            )
          );
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;