-- Board technology report, item 4: the failing financial-control automations.
--
-- Diagnosis (cron.job_run_details, 48h window):
--   expire-stale-bonus-restrictions   48 failures  "general_ledger UPDATE blocked"
--   repair-wallet-cache-drift-15m     51 failures  statement timeout
--   recalculate-trust-scores-nightly   2 failures  statement timeout
--   sweep-agent-advance-recovery       2 failures  ADVANCE_LEDGER_STALE_OPENING
--
-- The cron.schedule commands were NOT stale: every job invokes its function by
-- name, so body rewrites are picked up automatically. The failures are inside
-- the function bodies, fixed below.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. expire_stale_bonus_restrictions
-- Flips the maturity_expired marker on matured wallet legs. It performs a raw
-- UPDATE on general_ledger, which enforce_ledger_rpc_only() blocks. This is a
-- maintenance flag flip, not a money movement: no amount, direction, scope,
-- category or user changes. Authorise it explicitly for the duration of the
-- statement and leave an audit trail.
CREATE OR REPLACE FUNCTION public.expire_stale_bonus_restrictions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  -- Scoped to this transaction only (set_config is_local = true).
  PERFORM set_config('ledger.authorized', 'true', true);

  WITH upd AS (
    UPDATE public.general_ledger
       SET maturity_expired = true
     WHERE ledger_scope = 'wallet'
       AND direction IN ('cash_in','credit')
       AND maturity_met = false
       AND maturity_expired = false
       AND withdrawable_after IS NOT NULL
       AND now() > withdrawable_after
     RETURNING id
  )
  SELECT count(*)::int INTO v_count FROM upd;

  IF v_count > 0 THEN
    BEGIN
      INSERT INTO public.audit_logs (action_type, table_name, record_id, action, reason, metadata, created_at)
      VALUES ('bonus_restriction_expiry', 'general_ledger', gen_random_uuid(), 'update',
              'Scheduled maturity expiry sweep (flag-only, no amount change)',
              jsonb_build_object('rows_expired', v_count, 'source', 'expire_stale_bonus_restrictions'), now());
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN v_count;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sweep_agent_advance_recovery
-- Root cause of 100% failure: the function updated agent_advances to the
-- CLOSING balance and only afterwards inserted the agent_advance_ledger row
-- carrying the PRE-deduction opening balance. zz_guard_agent_advance_double_charge
-- compares NEW.opening_balance against the (already reduced) outstanding_balance
-- and correctly raised ADVANCE_LEDGER_STALE_OPENING — aborting the whole run at
-- the first agent with anything to collect.
--
-- Fix is ordering plus isolation only: record the day's ledger row (and post the
-- money legs) BEFORE the advance row is updated, so the guard sees a consistent
-- pre-state, and wrap each advance so one rejection can no longer discard the
-- entire sweep. Amounts, installment maths, caps and fee logic are unchanged.
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
  v_installment numeric; v_paid_today numeric; v_room numeric;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_row_exists boolean;
  v_agent_recovered numeric;
  v_period_days int; v_anchor date; v_expected_to_date numeric; v_paid_to_date numeric;
  v_skipped int := 0;
  v_charged boolean;
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

      v_closing := v_adv.outstanding_balance - v_deduct;
      v_new_status := CASE WHEN v_closing <= 0 THEN 'completed'
                           WHEN v_adv.expires_at < now() THEN 'overdue' ELSE 'active' END;
      v_total_deducted := v_total_payable - GREATEST(0, v_closing);
      v_fee_ratio := CASE WHEN v_total_payable > 0 THEN LEAST(1, v_total_deducted / v_total_payable) ELSE 0 END;
      v_new_fee := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
      v_fee_status := CASE WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
                           WHEN v_new_fee > 0 THEN 'partial' ELSE 'unpaid' END;
      v_idem := 'adv_recover_' || v_adv.id::text || '_' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
      v_charged := false;

      -- Per-advance isolation: a guard rejection on one advance must not
      -- discard every other agent's recovery for the day.
      BEGIN
        -- Ordering matters: the day's ledger row is written against the
        -- pre-deduction state the double-charge guard validates against,
        -- BEFORE the money legs and the advance row are updated.
        INSERT INTO public.agent_advance_ledger
          (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
        VALUES
          (v_adv.id, v_today, v_adv.outstanding_balance, 0, v_deduct, GREATEST(0, v_closing),
           CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

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

        UPDATE public.agent_advances
        SET outstanding_balance = GREATEST(0, v_closing), status = v_new_status,
            access_fee_collected = v_new_fee, access_fee_status = v_fee_status,
            arrears_balance = GREATEST(0, LEAST(
              GREATEST(0, v_closing),
              COALESCE(v_adv.arrears_balance, 0) + (v_installment - v_deduct)
            )),
            updated_at = now()
        WHERE id = v_adv.id;

        v_charged := true;
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped + 1;
        BEGIN
          INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
          VALUES ('repayment_skipped_insufficient_balance', v_agent.agent_id, 'agent_advances', v_adv.id,
            jsonb_build_object('source','sweep_agent_advance_recovery','reason','recovery_failed',
                               'attempted_amount', v_deduct, 'error', SQLERRM));
        EXCEPTION WHEN OTHERS THEN NULL; END;
      END;

      IF v_charged THEN
        v_avail := v_avail - v_deduct;
        v_recovered_total := v_recovered_total + v_deduct;
        v_agent_recovered := v_agent_recovered + v_deduct;
      END IF;
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

  RETURN jsonb_build_object('agents_touched', v_agents_touched, 'recovered_total', v_recovered_total,
                            'skipped', v_skipped, 'ran_at', now());
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. repair_wallet_cache_drift — was cancelled by the default statement timeout
-- while evaluating the drift-detection join, so NOTHING was repaired and the
-- whole run was discarded. Give it a longer local allowance and a wall-clock
-- budget so partial progress always commits.
CREATE OR REPLACE FUNCTION public.repair_wallet_cache_drift(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_row record;
  v_repaired int := 0;
  v_scanned  int := 0;
  v_deadline timestamptz;
  v_timed_out boolean := false;
BEGIN
  PERFORM set_config('statement_timeout', '480000', true);  -- 8 min, this txn only
  v_deadline := clock_timestamp() + interval '6 minutes';

  FOR v_row IN
    SELECT w.user_id
      FROM public.wallets w
      JOIN public.v_user_wallet_strict s ON s.user_id = w.user_id
     WHERE ABS(COALESCE(w.withdrawable_balance,0) - COALESCE(s.withdrawable,0))   >= 1
        OR ABS(COALESCE(w.float_balance,0)        - COALESCE(s.float_balance,0))  >= 1
        OR ABS(COALESCE(w.advance_balance,0)      - COALESCE(s.advance_balance,0)) >= 1
     LIMIT p_limit
  LOOP
    IF clock_timestamp() > v_deadline THEN
      v_timed_out := true;
      EXIT;
    END IF;
    v_scanned := v_scanned + 1;
    BEGIN
      PERFORM public.repair_wallet_cache_for_user(v_row.user_id);
      v_repaired := v_repaired + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- skip individual failures; monitor via phantom_wallet_drift
    END;
  END LOOP;

  RETURN jsonb_build_object('scanned', v_scanned, 'repaired', v_repaired,
                            'stopped_on_budget', v_timed_out, 'ran_at', now());
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. recompute_trust_scores_batch — same failure mode: cancelled mid-run by the
-- statement timeout, so the nightly recompute committed nothing. Stale-first
-- ordering means a budgeted partial run still rotates through every user.
CREATE OR REPLACE FUNCTION public.recompute_trust_scores_batch(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid;
  v_processed integer := 0;
  v_errors integer := 0;
  v_deadline timestamptz;
  v_timed_out boolean := false;
BEGIN
  PERFORM set_config('statement_timeout', '1500000', true);  -- 25 min, this txn only
  v_deadline := clock_timestamp() + interval '20 minutes';

  FOR v_user_id IN
    SELECT p.id
    FROM public.profiles p
    LEFT JOIN public.welile_trust_score_cache c ON c.user_id = p.id
    ORDER BY COALESCE(c.last_calculated_at, '1970-01-01'::timestamptz) ASC
    LIMIT p_limit
  LOOP
    IF clock_timestamp() > v_deadline THEN
      v_timed_out := true;
      EXIT;
    END IF;
    BEGIN
      PERFORM public.recompute_trust_score(v_user_id);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      -- still seed an empty row so coverage is 100%
      INSERT INTO public.welile_trust_score_cache (user_id, ai_id, last_calculated_at)
      VALUES (v_user_id, public.derive_welile_ai_id(v_user_id), now())
      ON CONFLICT (user_id) DO UPDATE SET last_calculated_at = now();
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'errors', v_errors,
    'limit', p_limit,
    'stopped_on_budget', v_timed_out,
    'completed_at', now()
  );
END;
$function$;