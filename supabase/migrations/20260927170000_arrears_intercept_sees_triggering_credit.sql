-- Agent Advance credit-time arrears recovery: let it see the earning that triggered it.
--
-- PROPOSED -- NOT APPLIED. Review before this is run against production.
--
-- ROOT CAUSE
-- ----------
-- `recover_agent_arrears_from_credit` reads the agent's spendable balance with
-- `get_user_available_balance`, which is a thin read of
-- `wallet_balances_projection.withdrawable`:
--
--   SELECT GREATEST(0, COALESCE((SELECT withdrawable FROM wallet_balances_projection
--                                 WHERE user_id = p_user_id), 0)
--                      - funder_pending_hold(...) - <advance lock, if paused>)
--
-- It does not read `general_ledger`. The projection is rewritten by
-- `refresh_wallet_projection_for()`, which is called from the AFTER ROW trigger
-- `trg_wallet_projection_ledger`.
--
-- PostgreSQL fires AFTER ROW triggers in alphabetical order by trigger name.
-- On `general_ledger` the relevant tail of that order is:
--
--    9  trg_log_ledger_wallet_transfer
--   10  trg_notify_agent_commission_paid
--   11  trg_recover_advance_arrears_on_earning   <-- recovery runs HERE
--   12  trg_sync_wallet_from_ledger              (intentional no-op since 2026-04-23)
--   13  trg_wallet_projection_ledger             <-- projection refreshed HERE
--
-- The recovery therefore reads the projection two triggers BEFORE the incoming
-- credit is written into it. It sees the agent's balance as it was *before* the
-- earning arrived. For an agent sitting at zero -- 314 of the 319 with arrears --
-- it reads 0, hits `IF v_available <= 0 THEN RETURN 0`, and exits silently.
-- No exception, no system_events row, nothing to notice.
--
-- This is a stale read, not a lock or concurrency problem, and not an
-- eligibility or cap problem. Proven by a discriminating rollback-only test in
-- production, on an agent holding 100,850 withdrawable with 516,801 arrears,
-- given a 150,000 commission credit:
--
--   projection      100,850 -> 150,000
--   recovery took   100,850
--   a STALE read predicts exactly  100,850
--   a FRESH read predicts          150,000
--
-- The recovery took the pre-credit figure to the shilling. It fired, it posted
-- both legs, it simply could not see the money that triggered it.
--
-- WHY NOT THE OTHER FIXES
-- -----------------------
--   Rename the trigger to sort after trg_wallet_projection_ledger -- works, and
--     costs nothing, but it makes correctness depend on an implicit alphabetical
--     ordering that any future migration can silently break, and this codebase
--     deliberately keeps trigger symbols stable (see the sync_wallet_from_ledger
--     no-op, retained only so references to its name still resolve).
--   Read general_ledger directly / recompute the balance -- would duplicate the
--     withdrawable formula, which lives in wallet_strict_for_user and folds in
--     bucket routing, pending holds and restricted amounts. Two copies of a
--     money formula will diverge. Rejected.
--   Deferred constraint trigger firing at COMMIT -- the projection would be
--     fresh, but a failure would then abort the commit and take the agent's
--     commission credit with it. Today a recovery failure is contained by the
--     caller's BEGIN/EXCEPTION block and the credit always survives. Rejected:
--     it trades a missed recovery for a lost earning.
--   Move recovery into apply_wallet_movement or the commission path -- touches
--     wallet movement logic, which is out of bounds.
--
-- THE FIX
-- -------
-- One statement: refresh this agent's projection before reading it, using the
-- system's own authoritative routine. Placed after the cheap argument guard so
-- it costs nothing on calls that were going to return 0 anyway.
--
-- `refresh_wallet_projection_for` recomputes from `wallet_strict_for_user`,
-- which reads the ledger, so the just-inserted credit is included. Measured in
-- production at ~9ms per call (the "~8s per call" note inside
-- refresh_wallet_projection_for describes the retired whole-ledger version, not
-- the current per-user one). The same routine runs again at trigger 13; the
-- upsert is idempotent, so the repeat is harmless.
--
-- This makes the function correct wherever it sits in the trigger order, rather
-- than correct only by virtue of its name.
--
-- OVER-COLLECTION
-- ---------------
-- Unchanged and still bounded four ways:
--   v_budget = LEAST(p_credit_amount, v_available)  -- never more than the
--              earning that triggered it, even though v_available is now larger
--   v_take   = LEAST(v_budget, arrears_balance, outstanding_balance)
--   zz_guard_agent_advance_double_charge: stale-opening, over-collection and
--              same-day cap checks, all untouched
-- Because v_budget is still capped by p_credit_amount, the fix cannot reach
-- further into a balance the agent already held than it could before.
--
-- NOTHING ELSE CHANGES
-- --------------------
-- Recovery amount and formula, arrears calculation, repayment logic, wallet
-- balances and movement, caps, concurrency and locking (the FOR UPDATE cursor is
-- untouched), the daily sweep, ROI recovery, notification logic and every Agent
-- Advance accounting mapping are all exactly as they are today. The corrected
-- write order from 20260927150000 -- daybook, then ledger, then advance -- is
-- preserved. The function body is otherwise byte-identical to what is deployed:
-- one line added, nothing removed, nothing reordered.

CREATE OR REPLACE FUNCTION public.recover_agent_arrears_from_credit(
  p_agent_id uuid,
  p_credit_amount numeric,
  p_trigger_ledger_id uuid DEFAULT NULL::uuid
)
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

  -- See the earning that triggered us. This runs as AFTER ROW trigger 11 of 13
  -- on general_ledger; the projection that get_user_available_balance reads is
  -- not refreshed until trigger 13, so without this the incoming credit is
  -- invisible and an agent at zero recovers nothing. Recomputes from the ledger
  -- via wallet_strict_for_user (~9ms); trigger 13 repeats it idempotently.
  PERFORM public.refresh_wallet_projection_for(p_agent_id);

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

    v_closing := v_adv.outstanding_balance - v_take;

    -- DAYBOOK FIRST. zz_guard_agent_advance_double_charge fires BEFORE INSERT
    -- and compares NEW.opening_balance against the advance's live balance, so
    -- it has to see the pre-payment state. This must run before the UPDATE
    -- below; previously it ran after, and the guard read our own reduction as
    -- another process's collection and blocked every recovery.
    INSERT INTO public.agent_advance_ledger
      (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
    VALUES
      (v_adv.id, current_date, v_adv.outstanding_balance, 0, v_take, GREATEST(0, v_closing),
       CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

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
          'amount', v_take, 'category', 'agent_advance_repayment',
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

REVOKE EXECUTE ON FUNCTION public.recover_agent_arrears_from_credit(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
