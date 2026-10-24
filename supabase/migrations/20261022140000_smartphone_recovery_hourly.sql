-- Smartphone daily instalment: collect at any hour, not only once at 18:00 Kampala.
--
-- Before: recover-smartphone-daily ran once (15:00 UTC) and a plan was skipped for the rest of
-- the day after its first collection, even a partial one. Agents earn commission during the
-- day and often withdraw it before 18:00, so the run found an almost empty wallet.
-- After: the sweep runs hourly and keeps collecting what is still due today.
--   * The daily cap is unchanged: at most 2 x daily instalment collected per Kampala day,
--     summed across all runs (the per-day accrual was already idempotent).
--   * A run takes at least UGX 1,000 unless that clears what is due, so small commissions
--     do not cause an hourly stream of tiny deductions and notifications.
--   * Idempotency key is per run (minute) instead of per day.
-- Ledger legs, wallet gate and plan updates are the same as the previous live version.

CREATE OR REPLACE FUNCTION public.recover_smartphone_from_wallets()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now_kla timestamp := now() AT TIME ZONE 'Africa/Kampala';
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_day_start timestamptz := ((now() AT TIME ZONE 'Africa/Kampala')::date)::timestamp AT TIME ZONE 'Africa/Kampala';
  v_min_take constant numeric := 1000;
  v_plan record; v_due numeric; v_daily numeric; v_avail numeric; v_amount numeric;
  v_taken_today numeric; v_room numeric;
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
    ORDER BY p.created_at
    FOR UPDATE OF p SKIP LOCKED
  LOOP
    IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = 'skipped_ineligible_order' WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'outcome', 'skipped_ineligible_order',
        'reason', public.merchandise_plan_ineligible_reason(v_plan.id));
      CONTINUE;
    END IF;
    v_daily := COALESCE(NULLIF(v_plan.daily_deduction_amount, 0), 0);
    IF v_daily <= 0 THEN CONTINUE; END IF;
    v_due := COALESCE(v_plan.due_balance, 0)
             + v_daily * GREATEST(0, v_today - GREATEST(COALESCE(v_plan.due_accrued_through, v_plan.starts_on - 1), v_plan.starts_on - 1));
    v_due := LEAST(v_due, v_plan.outstanding_balance);
    UPDATE public.merchandise_recovery_plans SET due_balance = v_due, due_accrued_through = v_today, last_attempt_on = v_today WHERE id = v_plan.id;

    -- What this sweep already took today (Returns-pledge rows carry a suffixed item_name).
    SELECT COALESCE(sum(d.amount), 0) INTO v_taken_today
    FROM public.merchandise_recovery_deductions d
    WHERE d.plan_id = v_plan.id AND d.created_at >= v_day_start
      AND d.item_name IS NOT DISTINCT FROM v_plan.item_name;
    v_room := GREATEST(0, 2 * v_daily - v_taken_today);

    v_avail := COALESCE(public.get_user_advance_reversal_available(v_plan.customer_id), 0);
    v_amount := floor(LEAST(v_due, v_room, v_avail, v_plan.outstanding_balance));
    IF v_amount <= 0 OR (v_amount < v_min_take AND v_amount < floor(v_due)) THEN
      UPDATE public.merchandise_recovery_plans
        SET last_attempt_result = CASE WHEN v_due <= 0 THEN 'nothing_due'
                                       WHEN v_room <= 0 THEN 'daily_cap_reached'
                                       ELSE 'wallet_short' END
        WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object('plan_id', v_plan.id, 'due', v_due, 'wallet', v_avail, 'taken_today', v_taken_today, 'taken', 0);
      CONTINUE;
    END IF;

    v_idem := 'phone_recover_v2_' || v_plan.id::text || '_' || to_char(v_now_kla, 'YYYYMMDDHH24MI');
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

-- Hourly at :07 (off the top of the hour, where several other jobs fire).
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('recover-smartphone-daily', 'recover-smartphone-hourly');
  PERFORM cron.schedule('recover-smartphone-hourly', '7 * * * *', 'SELECT public.recover_smartphone_from_wallets();');
END $$;
