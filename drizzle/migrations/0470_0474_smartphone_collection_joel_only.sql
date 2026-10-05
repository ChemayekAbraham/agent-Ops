ALTER TABLE public.merchandise_recovery_plans
  ADD COLUMN IF NOT EXISTS phone_collection_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.merchandise_recovery_plans.phone_collection_enabled IS
  'Per-plan opt-in for daily smartphone wallet collection (recover_smartphone_from_wallets). Off by default.';

-- 1. Phone repayments for opted-in plans may draw on advance-locked funds
--    (they repay the very advance the lock protects). Withdrawals stay locked.
DO $mig$
DECLARE v_def text; v_new text;
  v_old text := $o$  IF COALESCE(NEW.sub_category, '') LIKE 'advance_reversal:%' THEN$o$;
BEGIN
  v_def := pg_get_functiondef('public.enforce_no_negative_wallet_ledger()'::regprocedure);
  IF position(v_old in v_def) = 0 THEN RAISE EXCEPTION 'enforce_no_negative_wallet_ledger anchor not found'; END IF;
  v_new := replace(v_def, v_old,
$n$  IF COALESCE(NEW.sub_category, '') LIKE 'advance_reversal:%'
     OR (NEW.category = 'agent_repayment'
         AND NEW.source_table = 'merchandise_recovery_plans'
         AND EXISTS (SELECT 1 FROM public.merchandise_recovery_plans mp
                     WHERE mp.id = NEW.source_id AND mp.phone_collection_enabled
                       AND NOT COALESCE(mp.is_bike_lease, false))) THEN$n$);
  EXECUTE v_new;
END $mig$;

-- 2. Pause the smartphone late charge behind a control (off unless enabled).
DO $mig$
DECLARE v_def text;
  v_old text := E'BEGIN\n  FOR v_plan IN';
BEGIN
  v_def := pg_get_functiondef('public.apply_smartphone_overdue_surcharges()'::regprocedure);
  IF position(v_old in v_def) = 0 THEN RAISE EXCEPTION 'surcharge anchor not found'; END IF;
  EXECUTE replace(v_def, v_old, E'BEGIN\n  IF NOT COALESCE((SELECT enabled FROM public.treasury_controls WHERE control_key = ''smartphone_surcharge_enabled''), false) THEN\n    RETURN jsonb_build_object(''disabled'', true, ''reason'', ''smartphone_surcharge_enabled is off'');\n  END IF;\n  FOR v_plan IN');
END $mig$;

-- 3. Daily smartphone collection, opted-in plans only.
CREATE OR REPLACE FUNCTION public.recover_smartphone_from_wallets()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_plan record; v_due numeric; v_daily numeric; v_avail numeric; v_amount numeric;
  v_closing numeric; v_arrears numeric; v_idem text; v_err text;
  v_results jsonb := '[]'::jsonb; v_total numeric := 0; v_n int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('recover_smartphone_from_wallets')) THEN
    RETURN jsonb_build_object('skipped', 'another run in progress');
  END IF;
  FOR v_plan IN
    SELECT p.* FROM public.merchandise_recovery_plans p
    JOIN public.profiles pr ON pr.id = p.customer_id
    WHERE p.phone_collection_enabled AND p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease, false) AND NOT COALESCE(p.recovery_hold, false)
      AND NOT COALESCE(pr.is_test, false)
      AND p.starts_on IS NOT NULL AND p.starts_on <= v_today
      AND (p.last_success_on IS NULL OR p.last_success_on < v_today)
    ORDER BY p.created_at
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    v_daily := COALESCE(NULLIF(v_plan.daily_deduction_amount, 0), 0);
    IF v_daily <= 0 THEN CONTINUE; END IF;
    v_due := COALESCE(v_plan.due_balance, 0)
             + v_daily * GREATEST(0, v_today - GREATEST(COALESCE(v_plan.due_accrued_through, v_plan.starts_on - 1), v_plan.starts_on - 1));
    v_due := LEAST(v_due, v_plan.outstanding_balance);
    UPDATE public.merchandise_recovery_plans SET due_balance = v_due, due_accrued_through = v_today, last_attempt_on = v_today WHERE id = v_plan.id;

    v_avail := COALESCE(public.get_user_advance_reversal_available(v_plan.customer_id), 0);
    v_amount := floor(LEAST(v_due, 2 * v_daily, v_avail, v_plan.outstanding_balance));
    IF v_amount <= 0 THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = CASE WHEN v_due <= 0 THEN 'nothing_due' ELSE 'wallet_short' END WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'due', v_due, 'wallet', v_avail, 'taken', 0);
      CONTINUE;
    END IF;

    v_idem := 'phone_recover_v1_' || v_plan.id::text || '_' || to_char(v_today, 'YYYYMMDD');
    BEGIN
      PERFORM public.create_ledger_transaction(entries => jsonb_build_array(
        jsonb_build_object('user_id', v_plan.customer_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
          'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name, 'Welile Smartphone') || ' (daily instalment)'),
        jsonb_build_object('user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_amount, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
          'description', 'Smartphone advance recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Welile Smartphone'))
      ), idempotency_key => v_idem);
      v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
      v_arrears := GREATEST(0, v_due - v_amount);
      INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
        VALUES (v_plan.id, v_plan.customer_id, v_plan.item_name, v_amount, v_avail, v_closing, gen_random_uuid());
      UPDATE public.merchandise_recovery_plans
        SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
            due_balance = v_arrears, last_success_on = v_today, last_attempt_result = 'collected',
            last_recovery_at = now(),
            status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
            completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
        WHERE id = v_plan.id;
      IF v_plan.sale_id IS NOT NULL THEN
        UPDATE public.merchandise_sales SET amount_paid = COALESCE(amount_paid,0) + v_amount, amount_outstanding = v_closing,
          payment_status = CASE WHEN v_closing <= 0 THEN 'paid' ELSE 'partial' END, updated_at = now()
        WHERE id = v_plan.sale_id;
      END IF;
      INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path)
      VALUES (v_plan.customer_id, 'Smartphone payment collected',
        'UGX ' || to_char(v_amount, 'FM999,999,999,990') || ' was taken from your wallet for your smartphone. Balance left: UGX '
        || to_char(v_closing, 'FM999,999,999,990') || '.', 'merchandise_recovery',
        jsonb_build_object('kind','smartphone_recovery','plan_id',v_plan.id,'amount',v_amount,'arrears',v_arrears,'balance_left',v_closing,'kampala_day',v_today),
        '/merchandise');
      INSERT INTO public.system_events (event_type, user_id, metadata)
      VALUES ('payment_made', v_plan.customer_id, jsonb_build_object('source','smartphone_recovery','plan_id',v_plan.id,'amount',v_amount));
      v_n := v_n + 1; v_total := v_total + v_amount;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'due', v_due, 'wallet', v_avail, 'taken', v_amount, 'balance_left', v_closing);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = left('failed: ' || SQLERRM, 300) WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'error', v_err);
    END;
  END LOOP;
  RETURN jsonb_build_object('day', v_today, 'plans_collected', v_n, 'recovered_total', v_total, 'last_error', v_err, 'plans', v_results);
END $function$;

REVOKE ALL ON FUNCTION public.recover_smartphone_from_wallets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_smartphone_from_wallets() TO service_role;

SELECT cron.schedule('recover-smartphone-daily', '0 15 * * *', $c$SELECT public.recover_smartphone_from_wallets();$c$);