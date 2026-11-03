-- 2026-11-03: smartphone recovery accounting, A10 -> A12 / R1. Production apply needs explicit CFO approval.
-- CFO instruction 2026-11-03: smartphone recoveries are recognised as principal -> A12 (Merchandise and Smartphone
-- Recovery Receivable) and monthly charge -> R1 (Platform Revenue), not as agent advance repayments (A10).
--
-- ACCOUNTING ONLY. Unchanged: the wallet leg of every recovery (DR L1 agent_repayment, withdrawable, same amount,
-- same description), which plans are selected, how much is taken, the daily cap, plan and sale balances,
-- deductions, notifications, system events and idempotency keys. Only the company-side (platform) legs change:
--   * recover_smartphone_from_wallets() (hourly job) and apply_smartphone_roi_pledge() (monthly Returns pledge):
--     the single platform leg 'agent_advance_repayment' (-> A10) becomes 'merchandise_recovery_repayment' (-> A12)
--     for the principal part and 'access_fee_collected' (-> R1) for the charge part.
--   * new helper _smartphone_recovery_split(plan, amount, day): charge share of the schedule month containing the day
--     (charge_due / total_due), as the bike engine does; capped so a paid-off plan recognises exactly its principal
--     and its charges. _smartphone_recovery_split_safe(): on any error the whole amount is principal, so a collection
--     can never fail or change because of accounting.
--   * CFO "Money received" reports (get_cfo_received_by_category_totals / _page, get_cfo_received_agent_products_breakdown)
--     skip the reclassification groups: they count every platform cash_in as money received, and the reclassification
--     moves no money. Live recoveries still count in full: principal under Agent Products (Smartphone recoveries), the
--     charge under Revenue Collected (as bike lease fees already are).
--   * HISTORICAL RECLASSIFICATION (section 3): applying this file POSTS one new balanced group per historical smartphone
--     recovery in A10 (DR A10 / CR A12 principal / CR R1 charge), dated at apply time. No existing row is edited or
--     deleted (append-only); no wallet-scope leg is written. Done in the same transaction as the function change, under
--     the recovery job's advisory lock, so no recovery can fall between the two.
-- Categories, mappings and allowlist are reused unchanged (all three are mapped bucket-agnostic and allowlisted); the
-- balance-sheet resolver (sofp_ledger_legs) has no override for them, so each leg lands on its mapped account.
-- Preflight refuses (nothing changed) unless the two recovery functions, the three report functions, the resolver, the schedule builder and the posting
-- function are exactly the production definitions read on 2026-11-03, and the mappings are as expected.
-- Rollback: supabase/rollbacks/20261103200000_smartphone_recovery_to_a12.rollback.sql (functions only; reclassification entries stay - append-only).
-- Tests: src/test/smartphoneRecoveryAccounting.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
-- the hourly job takes this lock with pg_try_advisory_xact_lock and skips while it is held
SELECT pg_advisory_xact_lock(hashtext('recover_smartphone_from_wallets'));

DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.recover_smartphone_from_wallets()'))
       IS DISTINCT FROM 'c2c65f6994e6548f94c41346c6d08722'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_smartphone_roi_pledge(uuid, numeric, text)'))
       IS DISTINCT FROM 'b984f99c1808977646f88bda055619d5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_totals(date, date)'))
       IS DISTINCT FROM 'd1b7dd4113f0a861fe6da988a8e97008'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)'))
       IS DISTINCT FROM 'af27c0bb9f0507dd12ef581817690f79'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_agent_products_breakdown(date, date)'))
       IS DISTINCT FROM '9353e5d5458d62f6f2413e710134a85e'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)'))
       IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.smartphone_reducing_schedule(numeric, integer, date)'))
       IS DISTINCT FROM 'ac1512654e75942c484476f638c6dca2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)'))
       IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b' THEN
    RAISE EXCEPTION 'smartphone recovery accounting: preflight refused - a function differs from the production definition of 2026-11-03';
  END IF;
  IF (SELECT count(*) FROM public.ledger_account_map m
      WHERE m.wallet_bucket IS NULL AND (m.ledger_scope, m.category, m.account_code, m.debit_when) IN (
        ('platform', 'agent_advance_repayment', 'A10', 'cash_out'),
        ('platform', 'merchandise_recovery_repayment', 'A12', 'cash_out'),
        ('platform', 'access_fee_collected', 'R1', 'cash_out'))) <> 3
     OR EXISTS (SELECT 1 FROM public.ledger_account_map m WHERE m.wallet_bucket IS NOT NULL AND m.ledger_scope = 'platform'
                AND m.category IN ('agent_advance_repayment', 'merchandise_recovery_repayment', 'access_fee_collected'))
     OR NOT (public.ledger_category_allowlist() @> ARRAY['agent_advance_repayment', 'merchandise_recovery_repayment', 'access_fee_collected'])
  THEN
    RAISE EXCEPTION 'smartphone recovery accounting: ledger_account_map / allowlist not as expected (A10 / A12 / R1)';
  END IF;
  IF to_regprocedure('public._smartphone_recovery_split(uuid, numeric, date)') IS NOT NULL
     OR to_regprocedure('public._smartphone_recovery_split_safe(uuid, numeric, date)') IS NOT NULL THEN
    RAISE EXCEPTION 'smartphone recovery accounting: helper already exists';
  END IF;
END $pre$;

-- ---------------------------------------------------------------- 1. split helpers (closed: owner / service_role only)
CREATE OR REPLACE FUNCTION public._smartphone_recovery_split(p_plan_id uuid, p_amount numeric, p_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
-- Accounting split of ONE smartphone recovery (CFO decision 2026-11-03): principal -> A12, monthly charge -> R1.
-- Reads only; posts nothing. The charge share is the share of charge in the schedule month that contains p_on
-- (charge_due / total_due), the same rule the bike engine uses (_merch_bike_day fee_ratio). Schedule, in order:
--   1. the stored schedule (smartphone_repayment_schedules) when it adds up to the plan's original_amount;
--   2. otherwise the schedule rebuilt with smartphone_reducing_schedule(principal, months, starts_on) for the
--      number of months (1-12) whose total equals original_amount (plans with no or stale stored rows);
--   3. otherwise one average ratio (original_amount - principal) / original_amount;
--   4. no principal known: everything is principal.
-- Caps, from this plan's earlier recoveries in the ledger (source merchandise_recovery_plans): charge never exceeds
-- the schedule's charges still unrecognised; principal never exceeds the principal still unrecovered while charges
-- remain, so a plan that is paid off has recognised exactly its principal and its charges.
DECLARE
  v_plan record; v_base numeric; v_m int; v_i int; v_n int := 0; v_rows jsonb; v_basis text; v_row jsonb;
  v_amount numeric := round(COALESCE(p_amount, 0));
  v_charges numeric; v_principal_total numeric; v_ratio numeric := 0;
  v_prior_charge numeric := 0; v_prior_principal numeric := 0;
  v_charge numeric; v_principal numeric; v_rem_p numeric; v_shift numeric;
BEGIN
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('principal', 0, 'charge', 0, 'basis', 'nothing', 'ratio', 0);
  END IF;
  SELECT p.id, p.sale_id, p.original_amount, p.starts_on, s.disbursed_amount, s.total_revenue
    INTO v_plan
  FROM public.merchandise_recovery_plans p LEFT JOIN public.merchandise_sales s ON s.id = p.sale_id
  WHERE p.id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'smartphone recovery split: plan % not found', p_plan_id;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('ps', r.period_start, 'pe', r.period_end, 'c', r.charge_due, 't', r.total_due,
                                      'p', r.principal_due) ORDER BY r.month_index), count(*)
    INTO v_rows, v_n
  FROM public.smartphone_repayment_schedules r WHERE r.sale_id = v_plan.sale_id;
  IF v_n > 0 AND (SELECT sum((e->>'t')::numeric) FROM jsonb_array_elements(v_rows) e) = v_plan.original_amount THEN
    v_basis := 'stored_schedule';
  ELSE
    v_rows := NULL;
    v_base := COALESCE(NULLIF(v_plan.disbursed_amount, 0), NULLIF(v_plan.total_revenue, 0));
    IF v_base > 0 AND v_plan.starts_on IS NOT NULL THEN
      FOR v_i IN 1..12 LOOP
        v_m := v_i;
        SELECT jsonb_agg(jsonb_build_object('ps', s.period_start, 'pe', s.period_end, 'c', s.charge_due, 't', s.total_due,
                                            'p', s.principal_due) ORDER BY s.month_index)
          INTO v_rows
        FROM public.smartphone_reducing_schedule(v_base, v_i, v_plan.starts_on) s;
        EXIT WHEN (SELECT sum((e->>'t')::numeric) FROM jsonb_array_elements(v_rows) e) = v_plan.original_amount;
        v_rows := NULL;
      END LOOP;
    END IF;
    IF v_rows IS NOT NULL THEN
      v_basis := 'rebuilt_schedule_' || v_m || 'm';
    ELSIF v_base > 0 AND v_plan.original_amount > v_base THEN
      v_basis := 'plan_average';
      v_rows := jsonb_build_array(jsonb_build_object('ps', NULL, 'pe', NULL, 'c', v_plan.original_amount - v_base,
                                                     't', v_plan.original_amount, 'p', v_base));
    ELSE
      v_basis := 'no_charge_known';
      v_rows := jsonb_build_array(jsonb_build_object('ps', NULL, 'pe', NULL, 'c', 0, 't', v_amount, 'p', v_amount));
    END IF;
  END IF;

  SELECT e INTO v_row FROM jsonb_array_elements(v_rows) WITH ORDINALITY x(e, i)
  WHERE e->>'ps' IS NULL OR p_on BETWEEN (e->>'ps')::date AND (e->>'pe')::date
  ORDER BY i LIMIT 1;
  IF v_row IS NULL THEN
    v_row := CASE WHEN p_on < (v_rows->0->>'ps')::date THEN v_rows->0 ELSE v_rows->-1 END;
  END IF;
  IF COALESCE((v_row->>'t')::numeric, 0) > 0 THEN
    v_ratio := (v_row->>'c')::numeric / (v_row->>'t')::numeric;
  END IF;
  SELECT sum((e->>'c')::numeric), sum((e->>'p')::numeric) INTO v_charges, v_principal_total
  FROM jsonb_array_elements(v_rows) e;
  IF v_basis = 'no_charge_known' THEN v_principal_total := NULL; END IF;

  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END)
                    FILTER (WHERE g.category = 'access_fee_collected'), 0),
         COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END)
                    FILTER (WHERE g.category = 'merchandise_recovery_repayment'), 0)
    INTO v_prior_charge, v_prior_principal
  FROM public.general_ledger g
  WHERE g.source_table = 'merchandise_recovery_plans' AND g.source_id = p_plan_id AND g.ledger_scope = 'platform'
    AND g.category IN ('access_fee_collected', 'merchandise_recovery_repayment');

  v_charge := LEAST(round(v_amount * v_ratio), GREATEST(v_charges - v_prior_charge, 0));
  v_principal := v_amount - v_charge;
  IF v_principal_total IS NOT NULL THEN
    v_rem_p := GREATEST(v_principal_total - v_prior_principal, 0);
    IF v_principal > v_rem_p THEN
      v_shift := LEAST(v_principal - v_rem_p, GREATEST(v_charges - v_prior_charge - v_charge, 0));
      v_charge := v_charge + v_shift;
      v_principal := v_principal - v_shift;
    END IF;
  END IF;
  RETURN jsonb_build_object('principal', v_principal, 'charge', v_charge, 'basis', v_basis, 'ratio', v_ratio,
                            'charges_total', v_charges, 'principal_total', v_principal_total,
                            'prior_charge', v_prior_charge, 'prior_principal', v_prior_principal);
END $function$;

CREATE OR REPLACE FUNCTION public._smartphone_recovery_split_safe(p_plan_id uuid, p_amount numeric, p_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
-- The split for the live recovery paths: if the split cannot be worked out, the whole amount goes to A12 (principal)
-- so a collection never fails or changes because of accounting. Outcome is visible in the returned basis.
DECLARE v jsonb;
BEGIN
  BEGIN
    v := public._smartphone_recovery_split(p_plan_id, p_amount, p_on);
    IF (v->>'principal')::numeric < 0 OR (v->>'charge')::numeric < 0
       OR (v->>'principal')::numeric + (v->>'charge')::numeric <> round(COALESCE(p_amount, 0)) THEN
      RAISE EXCEPTION 'inconsistent split %', v;
    END IF;
    RETURN v;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('principal', round(COALESCE(p_amount, 0)), 'charge', 0, 'basis', 'fallback: ' || SQLERRM, 'ratio', 0);
  END;
END $function$;

REVOKE ALL ON FUNCTION public._smartphone_recovery_split(uuid, numeric, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._smartphone_recovery_split_safe(uuid, numeric, date) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 2. recovery paths: platform legs only
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
  v_split jsonb; v_prin_part numeric; v_charge_part numeric; v_entries jsonb;
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
      -- 2026-11-03 (CFO): principal -> A12 (merchandise_recovery_repayment), charge -> R1 (access_fee_collected);
      -- was one A10 leg (agent_advance_repayment). The wallet leg is unchanged.
      v_split := public._smartphone_recovery_split_safe(v_plan.id, v_amount, v_today);
      v_prin_part := (v_split->>'principal')::numeric;
      v_charge_part := (v_split->>'charge')::numeric;
      v_entries := jsonb_build_array(
        jsonb_build_object('user_id', v_plan.customer_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
          'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name, 'Welile Smartphone') || ' (daily instalment)'));
      IF v_prin_part > 0 THEN
        v_entries := v_entries || jsonb_build_object('user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_prin_part, 'category', 'merchandise_recovery_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
          'description', 'Smartphone cost recovered from agent wallet: ' || COALESCE(v_plan.item_name, 'Welile Smartphone'));
      END IF;
      IF v_charge_part > 0 THEN
        v_entries := v_entries || jsonb_build_object('user_id', v_plan.customer_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_charge_part, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
          'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
          'description', 'Smartphone monthly charge collected: ' || COALESCE(v_plan.item_name, 'Welile Smartphone'));
      END IF;
      PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => v_idem);
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

CREATE OR REPLACE FUNCTION public.apply_smartphone_roi_pledge(p_user_id uuid, p_roi_amount numeric, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_p record; v_plan record; v_pledged numeric; v_avail numeric; v_amount numeric; v_closing numeric;
  v_split jsonb; v_prin_part numeric; v_charge_part numeric; v_entries jsonb;
BEGIN
  IF COALESCE(p_roi_amount,0) <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','no_roi'); END IF;
  IF EXISTS (SELECT 1 FROM public.smartphone_roi_pledge_applications WHERE reference = p_reference) THEN
    RETURN jsonb_build_object('applied',0,'reason','already_applied');
  END IF;
  SELECT * INTO v_p FROM public.smartphone_roi_pledges WHERE user_id = p_user_id AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_pledge'); END IF;
  SELECT p.* INTO v_plan FROM public.merchandise_recovery_plans p
    JOIN public.merchandise_sales s ON s.id = p.sale_id
    WHERE p.customer_id = p_user_id AND p.status = 'active' AND p.outstanding_balance > 0
      AND NOT COALESCE(p.is_bike_lease,false) AND s.item_name ILIKE '%smartphone%'
    ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',0,'reason','no_plan'); END IF;
  v_pledged := CASE WHEN v_p.mode = 'percent' THEN floor(p_roi_amount * v_p.value / 100) ELSE v_p.value END;
  v_avail := COALESCE(public.get_user_available_balance(p_user_id),0);
  v_amount := floor(LEAST(v_pledged, p_roi_amount, v_plan.outstanding_balance, v_avail));
  IF v_amount <= 0 THEN RETURN jsonb_build_object('applied',0,'reason','nothing_available'); END IF;

  -- 2026-11-03 (CFO): principal -> A12 (merchandise_recovery_repayment), charge -> R1 (access_fee_collected);
  -- was one A10 leg (agent_advance_repayment). The wallet leg is unchanged.
  v_split := public._smartphone_recovery_split_safe(v_plan.id, v_amount, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_prin_part := (v_split->>'principal')::numeric;
  v_charge_part := (v_split->>'charge')::numeric;
  v_entries := jsonb_build_array(
    jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
      'amount', v_amount, 'category', 'agent_repayment', 'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone repayment - ' || COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)'));
  IF v_prin_part > 0 THEN
    v_entries := v_entries || jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_prin_part, 'category', 'merchandise_recovery_repayment', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone cost recovered from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'));
  END IF;
  IF v_charge_part > 0 THEN
    v_entries := v_entries || jsonb_build_object('user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
      'amount', v_charge_part, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', v_plan.id, 'currency', 'UGX',
      'description', 'Smartphone monthly charge collected from monthly Returns: ' || COALESCE(v_plan.item_name,'Welile Smartphone'));
  END IF;
  PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => 'phone_roi_pledge_' || p_reference);

  v_closing := GREATEST(0, v_plan.outstanding_balance - v_amount);
  INSERT INTO public.merchandise_recovery_deductions (plan_id, customer_id, item_name, amount, withdrawable_before, outstanding_after, transaction_ref)
    VALUES (v_plan.id, p_user_id, COALESCE(v_plan.item_name,'Welile Smartphone') || ' (from monthly Returns)', v_amount, v_avail, v_closing, gen_random_uuid());
  UPDATE public.merchandise_recovery_plans
    SET outstanding_balance = v_closing, amount_recovered = amount_recovered + v_amount,
        due_balance = GREATEST(0, COALESCE(due_balance,0) - v_amount), last_recovery_at = now(),
        status = CASE WHEN v_closing <= 0 THEN 'completed' ELSE status END,
        completed_at = CASE WHEN v_closing <= 0 THEN now() ELSE completed_at END, updated_at = now()
    WHERE id = v_plan.id;
  UPDATE public.merchandise_sales
    SET amount_paid = COALESCE(amount_paid,0) + v_amount,
        amount_outstanding = GREATEST(0, COALESCE(amount_outstanding,0) - v_amount), updated_at = now()
    WHERE id = v_plan.sale_id;
  INSERT INTO public.smartphone_roi_pledge_applications(user_id, plan_id, reference, roi_amount, pledged_amount, applied_amount, outstanding_after)
    VALUES (p_user_id, v_plan.id, p_reference, p_roi_amount, v_pledged, v_amount, v_closing);
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, metadata)
    VALUES ('payment_made', p_user_id, jsonb_build_object('kind','smartphone_roi_pledge_applied','amount',v_amount,'plan_id',v_plan.id,'reference',p_reference));
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('applied', v_amount, 'outstanding_after', v_closing);
END $function$;

-- ---------------------------------------------------------------- 2b. Money received reports: skip the reclassification
CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_totals(p_from date, p_to date)
 RETURNS TABLE(category_key text, category_label text, nature text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH raw AS MATERIALIZED (
    SELECT g.category AS c, g.source_table AS s, sum(g.amount) AS amt, count(*) AS n
    FROM public.general_ledger g
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
    GROUP BY g.category, g.source_table
  ), agg AS (
    SELECT public._cfo_received_category_for(r.c, r.s) AS cat_key, sum(r.amt) AS amt, sum(r.n) AS n
    FROM raw r GROUP BY 1
  ), agg2 AS (SELECT * FROM agg WHERE agg.cat_key IS NOT NULL),
  grand AS (SELECT COALESCE(sum(a.amt), 0) AS total FROM agg2 a)
  SELECT f.k, f.l, f.nat, f.s, round(COALESCE(a.amt, 0), 2), COALESCE(a.n, 0)::bigint,
         round(CASE WHEN gr.total > 0 THEN COALESCE(a.amt, 0) * 100 / gr.total ELSE 0 END, 2)
  FROM (VALUES
    ('partner', 'Partner Products and Services', 'capital', 1),
    ('land', 'Tenant Products and Services', 'recovery', 2),
    ('landlord', 'Landlord Products and Services', 'recovery', 3),
    ('agent', 'Agent Products and Services', 'recovery', 4),
    ('fees', 'Revenue Collected', 'income', 5),
    ('other_income', 'Other Income', 'income', 6),
    ('capital', 'Share Capital', 'capital', 7)
  ) AS f(k, l, nat, s)
  LEFT JOIN agg2 a ON a.cat_key = f.k
  CROSS JOIN grand gr
  ORDER BY f.s;
END $function$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz; v_search text := nullif(btrim(p_search), '');
        v_type text := nullif(btrim(lower(p_type)), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  IF v_type IS NOT NULL AND v_type NOT IN ('smartphone', 'bike', 'advance') THEN
    RAISE EXCEPTION 'unknown product type %', p_type USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH base AS MATERIALIZED (
    SELECT g.id AS gid, g.transaction_date AS tdate, g.category AS c, g.source_table AS s,
           mp.is_bike_lease AS bike
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON v_type IS NOT NULL AND g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND (v_search IS NULL OR COALESCE(g.description, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.reference_id, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.linked_party, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.full_name, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.phone, '') ILIKE '%' || v_search || '%')
  ), cmap AS MATERIALIZED (
    SELECT d.c, d.s, public._cfo_received_category_for(d.c, d.s) AS ckey,
           public._cfo_received_category_for(d.c) AS plain
    FROM (SELECT DISTINCT b.c, b.s FROM base b) d
  ), pmap AS MATERIALIZED (
    SELECT d.c, d.s, d.bike, public._cfo_received_agent_product_for(d.c, d.s, d.bike) AS pkey
    FROM (SELECT DISTINCT b.c, b.s, b.bike FROM base b WHERE v_type IS NOT NULL) d
  ), f AS (
    SELECT b.gid, b.tdate, cm.ckey,
           CASE WHEN v_type IS NOT NULL AND cm.plain = 'agent' THEN pm.pkey END AS pkey
    FROM base b
    JOIN cmap cm ON cm.c IS NOT DISTINCT FROM b.c AND cm.s IS NOT DISTINCT FROM b.s
    LEFT JOIN pmap pm ON pm.c IS NOT DISTINCT FROM b.c AND pm.s IS NOT DISTINCT FROM b.s
                     AND pm.bike IS NOT DISTINCT FROM b.bike
  ), m AS (
    SELECT f.gid, f.tdate, f.ckey, count(*) OVER () AS n
    FROM f WHERE f.ckey IS NOT NULL AND (p_category IS NULL OR f.ckey = p_category)
      AND (v_type IS NULL OR f.pkey = v_type)
  ), pg AS (
    SELECT m.gid, m.tdate, m.ckey, m.n FROM m ORDER BY m.tdate DESC, m.gid
    LIMIT least(greatest(COALESCE(p_limit, 50), 1), 1000) OFFSET greatest(COALESCE(p_offset, 0), 0)
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'partner' THEN 'Partner Products and Services' WHEN 'land' THEN 'Tenant Products and Services'
           WHEN 'landlord' THEN 'Landlord Products and Services'
           WHEN 'agent' THEN 'Agent Products and Services' WHEN 'fees' THEN 'Revenue Collected'
           WHEN 'other_income' THEN 'Other Income' WHEN 'capital' THEN 'Share Capital' END,
         g.category, round(g.amount, 2), g.description, g.reference_id,
         COALESCE(cp.full_name, p.full_name), COALESCE(cp.phone, p.phone),
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_out' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END $function$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_agent_products_breakdown(p_from date, p_to date)
 RETURNS TABLE(product_key text, product_label text, amount numeric, tx_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH x AS (
    SELECT g.amount,
      public._cfo_received_agent_product_for(g.category, g.source_table, mp.is_bike_lease) AS k
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND left(COALESCE(g.idempotency_key, ''), 30) <> 'smartphone_a10_to_a12_reclass:' -- 2026-11-03: not money received (reclassification)
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND public._cfo_received_category_for(g.category) = 'agent'
  )
  SELECT x.k,
    CASE x.k WHEN 'smartphone' THEN 'Smartphone recoveries' WHEN 'bike' THEN 'Bike recoveries'
             WHEN 'rejection' THEN 'Rejection charges' ELSE 'Agent advance repayments' END,
    round(sum(x.amount), 2), count(*)
  FROM x GROUP BY x.k ORDER BY 3 DESC;
END $function$;

-- ---------------------------------------------------------------- 3. historical reclassification (append-only)
-- One NEW balanced group per historical smartphone recovery that went to A10 (platform agent_advance_repayment,
-- source merchandise_recovery_plans): DR A10 the full amount, CR A12 the principal part, CR R1 the charge part, split
-- with the same rule as new recoveries at the recovery's Kampala date, oldest first. Nothing existing is edited.
-- Idempotent (key smartphone_a10_to_a12_reclass:<original leg id>). Wallets are not touched (platform legs only).
DO $reclass$
DECLARE
  r record; v_split jsonb; v_p numeric; v_c numeric; v_entries jsonb; v_key text; v_n int := 0;
BEGIN
  FOR r IN
    SELECT g.id, g.transaction_group_id, g.user_id, g.source_id, g.amount, g.transaction_date
    FROM public.general_ledger g
    WHERE g.ledger_scope = 'platform' AND g.category = 'agent_advance_repayment' AND g.direction = 'cash_in'
      AND g.source_table = 'merchandise_recovery_plans'
    ORDER BY g.transaction_date, g.created_at, g.id
  LOOP
    v_key := 'smartphone_a10_to_a12_reclass:' || r.id::text;
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.general_ledger x WHERE x.idempotency_key = v_key);
    v_split := public._smartphone_recovery_split(r.source_id, r.amount, (r.transaction_date AT TIME ZONE 'Africa/Kampala')::date);
    v_p := (v_split->>'principal')::numeric;
    v_c := (v_split->>'charge')::numeric;
    IF v_p < 0 OR v_c < 0 OR v_p + v_c <> r.amount THEN
      RAISE EXCEPTION 'smartphone reclassification: bad split % for ledger row %', v_split, r.id;
    END IF;
    v_entries := jsonb_build_array(jsonb_build_object('user_id', r.user_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
      'amount', r.amount, 'category', 'agent_advance_repayment', 'recipient_type', 'operational_wallet',
      'source_table', 'merchandise_recovery_plans', 'source_id', r.source_id, 'currency', 'UGX',
      'reference_id', r.transaction_group_id::text,
      'description', 'Reclassification (CFO 2026-11-03): smartphone recovery of ' || to_char(r.transaction_date AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
        || ' was posted to agent advances (A10); moved to smartphone receivable (A12) and charge income (R1)'));
    IF v_p > 0 THEN
      v_entries := v_entries || jsonb_build_object('user_id', r.user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', v_p, 'category', 'merchandise_recovery_repayment', 'recipient_type', 'operational_wallet',
        'source_table', 'merchandise_recovery_plans', 'source_id', r.source_id, 'currency', 'UGX',
        'reference_id', r.transaction_group_id::text,
        'description', 'Reclassification (CFO 2026-11-03): smartphone cost recovered (principal, ' || (v_split->>'basis') || ')');
    END IF;
    IF v_c > 0 THEN
      v_entries := v_entries || jsonb_build_object('user_id', r.user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', v_c, 'category', 'access_fee_collected', 'recipient_type', 'operational_wallet',
        'source_table', 'merchandise_recovery_plans', 'source_id', r.source_id, 'currency', 'UGX',
        'reference_id', r.transaction_group_id::text,
        'description', 'Reclassification (CFO 2026-11-03): smartphone monthly charge collected (' || (v_split->>'basis') || ')');
    END IF;
    PERFORM public.create_ledger_transaction(entries => v_entries, idempotency_key => v_key);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'smartphone reclassification: % groups posted', v_n;
END $reclass$;

-- ---------------------------------------------------------------- 4. post-checks
DO $post$
DECLARE v_open int; v_a10 numeric; v_bad int;
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.recover_smartphone_from_wallets()'))
       IS DISTINCT FROM '8e2ba4427f7d5555579c34bf96c95428'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_smartphone_roi_pledge(uuid, numeric, text)'))
       IS DISTINCT FROM '74ae9dca248b4b92e6e81a3bd472d997'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_totals(date, date)'))
       IS DISTINCT FROM 'ba864905b5bc7ff9165d47f9c946432a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer)'))
       IS DISTINCT FROM '6e69a2f7eacc80fa6d87ae4d18a8f5a5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_received_agent_products_breakdown(date, date)'))
       IS DISTINCT FROM 'c79bcf09662300dc96ac2f89f5880179'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.sofp_ledger_legs(timestamp with time zone)'))
       IS DISTINCT FROM '843ccf477014f8c7a8e0b5c6f14a1ba0'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.smartphone_reducing_schedule(numeric, integer, date)'))
       IS DISTINCT FROM 'ac1512654e75942c484476f638c6dca2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.create_ledger_transaction(jsonb, text, boolean)'))
       IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._smartphone_recovery_split(uuid, numeric, date)'))
       IS DISTINCT FROM '679dbcb343a41b6d6fe4cd005b9d6f63'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._smartphone_recovery_split_safe(uuid, numeric, date)'))
       IS DISTINCT FROM 'decb6400590313e77fd2ddf3ed7ffd54' THEN
    RAISE EXCEPTION 'smartphone recovery accounting: post-check failed (function fingerprints)';
  END IF;
  -- every historical A10 smartphone recovery has exactly one reclassification group
  SELECT count(*) INTO v_open FROM public.general_ledger g
  WHERE g.ledger_scope = 'platform' AND g.category = 'agent_advance_repayment' AND g.direction = 'cash_in'
    AND g.source_table = 'merchandise_recovery_plans'
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger x WHERE x.idempotency_key = 'smartphone_a10_to_a12_reclass:' || g.id::text);
  -- smartphone recoveries leave nothing in A10 (platform agent_advance_repayment, source merchandise_recovery_plans)
  SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END), 0) INTO v_a10
  FROM public.general_ledger g
  WHERE g.ledger_scope = 'platform' AND g.category = 'agent_advance_repayment' AND g.source_table = 'merchandise_recovery_plans';
  -- each reclassification group balances in money and in mapped accounts (DR = CR)
  SELECT count(*) INTO v_bad FROM (
    SELECT g.transaction_group_id
    FROM public.general_ledger g
    JOIN public.ledger_account_map m ON m.ledger_scope = g.ledger_scope AND m.category = g.category AND m.wallet_bucket IS NULL
    WHERE g.idempotency_key LIKE 'smartphone_a10_to_a12_reclass:%'
    GROUP BY 1
    HAVING sum(CASE WHEN g.direction = m.debit_when THEN g.amount ELSE -g.amount END) <> 0
        OR sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END) <> 0
        OR bool_or(g.ledger_scope <> 'platform')) z;
  IF v_open <> 0 OR v_a10 <> 0 OR v_bad <> 0 THEN
    RAISE EXCEPTION 'smartphone recovery accounting: post-check failed (unreclassified %, A10 residue %, unbalanced groups %)', v_open, v_a10, v_bad;
  END IF;
  IF has_function_privilege('authenticated', 'public._smartphone_recovery_split(uuid, numeric, date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._smartphone_recovery_split_safe(uuid, numeric, date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._smartphone_recovery_split_safe(uuid, numeric, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'smartphone recovery accounting: helper functions must not be callable by app users';
  END IF;
END $post$;
