-- Agent Advance credit-time arrears recovery: write the daybook row before the
-- advance balance, so the double-charge guard is not tripped by our own update.
--
-- THE FAULT
-- ---------
-- `recover_agent_arrears_from_credit` wrote in this order:
--
--   1. create_ledger_transaction(...)                        wallet + platform legs
--   2. UPDATE agent_advances SET outstanding_balance = ...    balance reduced
--   3. INSERT agent_advance_ledger (opening_balance = v_adv.outstanding_balance)
--
-- `v_adv` is the cursor snapshot, so step 3 carries the PRE-payment opening
-- balance while step 2 has already written the POST-payment balance to the row.
-- `zz_guard_agent_advance_double_charge` fires BEFORE INSERT and raises when
-- `NEW.opening_balance > agent_advances.outstanding_balance + 1`. The function
-- therefore blocked itself on every single recovery.
--
-- The gap was always exactly the amount being recovered. A live rejection of
-- 2026-09-26 reads "opening 2105165.48 exceeds true outstanding 2105051.48" --
-- a difference of 114, which was that credit's own v_take.
--
-- SCALE
-- -----
-- 9,407 ADVANCE_LEDGER_STALE_OPENING rejections across 80 advances since
-- 2026-08-01; the last successful recovery was 2026-09-23. In September alone:
-- 4,161 blocked attempts over 39 advances, 26 of them still open and carrying
-- 10,356,668.30 of arrears. The guard was correct throughout -- nothing was
-- double-charged and nothing was written -- but nothing was recovered either.
--
-- THE FIX
-- -------
-- Move the daybook INSERT to the top of the loop body, ahead of both the ledger
-- transaction and the balance update. This is the same correction already
-- proven on `voluntary-repay-advance` / `record_advance_voluntary_repayment_atomic`:
-- the guard is designed to validate against the pre-payment state, so let it
-- see the pre-payment state.
--
-- Reproduced against live rows before and after, inside a rolled-back DO block
-- (advances 67b4449b, ba37593d, ba7d6847, d1ec4c4c):
--   current order, take 5,000 -> REJECTED ADVANCE_LEDGER_STALE_OPENING (both tested)
--   fixed order,   take 5,000 -> ACCEPTED (both tested)
--   fixed order,   maximum take LEAST(arrears, outstanding) -> ACCEPTED (all four),
--     confirming that neither the over-collection check nor the same-day cap
--     (installment + arrears + 1) falsely rejects a full arrears recovery.
--
-- WHAT IS DELIBERATELY UNCHANGED
-- ------------------------------
--   * v_take and every other arithmetic line -- the recovery amount is identical.
--   * The create_ledger_transaction call, byte for byte: same legs, same amounts,
--     same categories, same recipient_type, same buckets, same idempotency key.
--     No wallet balance and no wallet movement logic is touched.
--   * The double-charge guard itself, and all three of its checks.
--   * Advance terms, installments, fee ratio, status transitions.
--   * All GL/accounting mappings. The new Agent Advance matrix stays inert.
--   * `recovery_source` still defaults to 'wallet_daily' on these rows. Tagging
--     them 'arrears_credit_intercept' would be an improvement but it changes
--     reporting, so it is left for a separate decision.
--
-- ATOMICITY
-- ---------
-- Unchanged and structural. This is a plpgsql FUNCTION, so it cannot COMMIT or
-- ROLLBACK; every write in one pass of the loop lives or dies together. The
-- caller `tg_recover_advance_arrears_on_earning` wraps the PERFORM in a
-- BEGIN/EXCEPTION block, which is a plpgsql subtransaction: if any step here
-- fails, this function's writes roll back and the agent's triggering earning
-- credit is untouched. That containment is preserved exactly.

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

-- CREATE OR REPLACE preserves the existing ACL, which is already restricted to
-- postgres and service_role -- no anon, no authenticated, no PUBLIC. Restated
-- here so a future DROP + CREATE cannot silently widen it.
REVOKE EXECUTE ON FUNCTION public.recover_agent_arrears_from_credit(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
