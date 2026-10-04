ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS recovery_source text NOT NULL DEFAULT 'wallet_daily',
  ADD COLUMN IF NOT EXISTS roi_recovery_percent numeric NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_advances_recovery_source_check'
  ) THEN
    ALTER TABLE public.agent_advances
      ADD CONSTRAINT agent_advances_recovery_source_check
      CHECK (recovery_source IN ('wallet_daily','roi'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_advances_roi_recovery_percent_check'
  ) THEN
    ALTER TABLE public.agent_advances
      ADD CONSTRAINT agent_advances_roi_recovery_percent_check
      CHECK (roi_recovery_percent >= 0 AND roi_recovery_percent <= 100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_advances_roi_recovery
  ON public.agent_advances (agent_id, status)
  WHERE recovery_source = 'roi';

-- Recovery engine: deduct configured % of an ROI payout toward the advance.
CREATE OR REPLACE FUNCTION public.apply_roi_advance_recovery(
  p_user_id uuid,
  p_roi_amount numeric,
  p_source_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Idempotency: never recover twice for the same ROI payout
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
      AND status IN ('active','overdue')
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
      (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
    VALUES
      (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_take, v_closing,
       CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

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
$$;

GRANT EXECUTE ON FUNCTION public.apply_roi_advance_recovery(uuid, numeric, uuid, text) TO authenticated, service_role;

-- Keep ROI-recovered advances out of the daily wallet sweep
CREATE OR REPLACE FUNCTION public.sweep_agent_advance_recovery()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_agent record; v_adv record;
  v_avail numeric; v_deduct numeric; v_closing numeric;
  v_total_payable numeric; v_total_deducted numeric;
  v_fee_ratio numeric; v_new_fee numeric; v_fee_status text; v_new_status text;
  v_recovered_total numeric := 0; v_agents_touched int := 0; v_idem text;
  v_scheduled_daily numeric; v_paid_today numeric; v_daily_room numeric;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_row_exists boolean;
  v_agent_recovered numeric;
  v_days_elapsed int; v_expected_to_date numeric; v_paid_to_date numeric;
BEGIN
  FOR v_agent IN
    SELECT DISTINCT agent_id FROM public.agent_advances
    WHERE status IN ('active','overdue') AND outstanding_balance > 0
      AND COALESCE(recovery_source, 'wallet_daily') <> 'roi'
  LOOP
    v_avail := COALESCE(public.get_agent_sweepable_withdrawable(v_agent.agent_id), 0);
    v_agent_recovered := 0;

    FOR v_adv IN
      SELECT * FROM public.agent_advances
      WHERE agent_id = v_agent.agent_id
        AND status IN ('active','overdue') AND outstanding_balance > 0
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

      v_total_payable := COALESCE(v_adv.principal,0) + COALESCE(v_adv.access_fee,0);
      v_scheduled_daily := COALESCE(NULLIF(v_adv.daily_installment,0),
                                    CASE WHEN COALESCE(v_adv.cycle_days,0) > 0
                                         THEN round(v_total_payable / v_adv.cycle_days) ELSE 0 END);
      IF v_scheduled_daily <= 0 THEN CONTINUE; END IF;

      v_days_elapsed := GREATEST(1, (v_today - (v_adv.issued_at AT TIME ZONE 'Africa/Kampala')::date));
      v_expected_to_date := LEAST(v_total_payable, v_scheduled_daily * v_days_elapsed);
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

      v_daily_room := GREATEST(0, (v_expected_to_date - v_paid_to_date) - v_paid_today);
      IF v_daily_room <= 0 THEN CONTINUE; END IF;

      v_deduct := LEAST(v_avail, v_adv.outstanding_balance, v_daily_room);
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
          access_fee_collected = v_new_fee, access_fee_status = v_fee_status, updated_at = now()
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