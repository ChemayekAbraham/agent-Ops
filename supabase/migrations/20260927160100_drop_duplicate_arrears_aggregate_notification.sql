-- Agent Advance credit-time recovery: drop the now-duplicate aggregate notification.
--
-- PROPOSED -- NOT APPLIED. Notification-only change.
--
-- REBASED 2026-09-27 onto the CURRENT production function, which is the
-- 139-line version deployed by 20260927170000 and carrying
-- `refresh_wallet_projection_for(p_agent_id)` before the balance read. An
-- earlier draft of this migration was written against the PRE-170000 body and
-- would have silently reverted that fix. This version is generated from the
-- deployed definition itself, verified identical to production before editing:
--
--   production full hash            e8441d2e563e831c039d47cccbb46fd0
--   production body lines           139
--   production body ordered hash    ae09ff39edb267c2bf155cc94ae7ce02
--   production body sorted  hash    062df03f52582d708ac6f033be109c3c
--
-- WHY
-- ---
-- `notify_agent_advance_deducted` now delivers (migration 20260927160000): the
-- allowlisted `advance_arrears` type, one notification per daybook row,
-- carrying the amount, the advance reference, the remaining balance and the
-- timestamp. This function also inserts its own aggregate message per credit
-- event:
--
--   "UGX 60,000 from your latest earning was automatically applied to your
--    missed advance repayment(s)."
--
-- An agent recovering against one advance receives both, for the same money,
-- seconds apart. The aggregate is the weaker of the two -- no advance
-- reference, no remaining balance, no timestamp -- so it is removed.
--
-- 903 of these were delivered historically, the last on 2026-09-23. Existing
-- rows are untouched; this only stops new ones.
--
-- EXACTLY WHAT CHANGES
-- --------------------
-- Sixteen lines deleted: the `INSERT INTO public.notifications ... );` block
-- inside `IF v_recovered > 0 THEN`, plus the blank line after it. Nothing
-- added, nothing reordered, nothing else altered. 139 -> 124 body lines.
--
-- Preserved verbatim: `refresh_wallet_projection_for(p_agent_id)` and its
-- position before `get_user_available_balance`; `LEAST(p_credit_amount,
-- v_available)`; `LEAST(v_budget, v_adv.arrears_balance,
-- v_adv.outstanding_balance)`; the `FOR UPDATE` cursor; the daybook-first
-- write order; the double-charge guard; the create_ledger_transaction call
-- byte for byte; every GL and accounting mapping; all wallet and repayment
-- logic. The `repayment_successful` system_events write stays -- it is
-- telemetry, not a message to the agent.

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
