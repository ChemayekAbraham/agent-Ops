-- Helper: withdrawable available to advance sweep, protecting peer-transfer credits.
-- Peer wallet_transfer inflows since the agent's oldest ACTIVE/OVERDUE advance are
-- shielded from auto-sweep. Any subsequent cash_out (transfer out, withdrawal, payment)
-- reduces the shield first — once spent, protection is gone.
CREATE OR REPLACE FUNCTION public.get_agent_sweepable_withdrawable(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_withdrawable numeric;
  v_since timestamptz;
  v_transfer_in numeric := 0;
  v_out_after  numeric := 0;
  v_protected  numeric;
BEGIN
  v_withdrawable := COALESCE(public.get_user_available_balance(p_user_id), 0);
  IF v_withdrawable <= 0 THEN RETURN 0; END IF;

  SELECT MIN(issued_at) INTO v_since
    FROM public.agent_advances
   WHERE agent_id = p_user_id
     AND status IN ('active','overdue')
     AND outstanding_balance > 0;

  IF v_since IS NULL THEN RETURN v_withdrawable; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_transfer_in
    FROM public.general_ledger
   WHERE user_id = p_user_id
     AND ledger_scope = 'wallet'
     AND direction = 'cash_in'
     AND category = 'wallet_transfer'
     AND created_at >= v_since;

  IF v_transfer_in <= 0 THEN RETURN v_withdrawable; END IF;

  -- Any non-advance-repayment debit since the oldest active advance consumes
  -- the transfer shield first. Prior auto-recovery legs must not eat it.
  SELECT COALESCE(SUM(amount), 0) INTO v_out_after
    FROM public.general_ledger
   WHERE user_id = p_user_id
     AND ledger_scope = 'wallet'
     AND direction = 'cash_out'
     AND category <> 'agent_repayment'
     AND created_at >= v_since;

  v_protected := GREATEST(0, v_transfer_in - v_out_after);
  RETURN GREATEST(0, v_withdrawable - v_protected);
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_sweepable_withdrawable(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_agent_sweepable_withdrawable(uuid) TO service_role, authenticated;

-- Rewire the 15-minute auto-recovery sweep to use the protected figure.
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
  v_scheduled_daily numeric; v_paid_today numeric; v_daily_room numeric;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_row_exists boolean;
  v_agent_recovered numeric;
BEGIN
  FOR v_agent IN
    SELECT DISTINCT agent_id FROM public.agent_advances
    WHERE status IN ('active','overdue') AND outstanding_balance > 0
  LOOP
    -- Protected withdrawable: peer wallet_transfer credits are shielded.
    v_avail := COALESCE(public.get_agent_sweepable_withdrawable(v_agent.agent_id), 0);
    v_agent_recovered := 0;

    FOR v_adv IN
      SELECT * FROM public.agent_advances
      WHERE agent_id = v_agent.agent_id
        AND status IN ('active','overdue') AND outstanding_balance > 0
      ORDER BY issued_at ASC
    LOOP
      SELECT EXISTS (
        SELECT 1 FROM public.agent_advance_ledger
        WHERE advance_id = v_adv.id AND date = v_today
      ) INTO v_row_exists;
      IF v_row_exists THEN CONTINUE; END IF;

      IF COALESCE(v_adv.prepaid_installments_remaining, 0) > 0 THEN
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, 0, v_adv.outstanding_balance, 'prepaid');
        UPDATE public.agent_advances
          SET prepaid_installments_remaining = GREATEST(0, prepaid_installments_remaining - 1),
              updated_at = now()
          WHERE id = v_adv.id;
        CONTINUE;
      END IF;

      EXIT WHEN v_avail <= 0;

      v_total_payable  := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
      v_scheduled_daily := CASE WHEN COALESCE(v_adv.cycle_days, 30) > 0
        THEN round(v_total_payable / COALESCE(v_adv.cycle_days, 30)) ELSE 0 END;

      SELECT COALESCE(SUM(amount_deducted), 0) INTO v_paid_today
        FROM public.agent_advance_ledger
       WHERE advance_id = v_adv.id AND date = v_today;

      v_daily_room := GREATEST(0, v_scheduled_daily + COALESCE(v_adv.arrears_balance, 0) - v_paid_today);
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