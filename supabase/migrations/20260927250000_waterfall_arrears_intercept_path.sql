-- Agent Advance waterfall, Stage E path 3 of 7:
-- recover_agent_arrears_from_credit -- the credit-time arrears intercept,
-- fired by trg_recover_advance_arrears_on_earning on an agent commission.
--
-- NOT YET APPLIED.
--
-- Built MECHANICALLY from migration 20260927160100, whose body was already
-- hash-verified against production (4ac32f1b4fd070e213bff0edec00ed89, 124
-- non-comment body lines, full definition 65d651ce08c07d3bbaec3b59135fe8de),
-- so every unchanged line carries no transcription risk.
--
-- Preserved exactly:
--   * the funding leg -- same category, recipient_type, description, currency
--     and metadata, for exactly v_take. Hoisted into v_funding and used by
--     BOTH branches, so the wallet gives up the same amount either way.
--   * `PERFORM public.refresh_wallet_projection_for(p_agent_id)` before the
--     balance read (the 20260927170000 fix).
--   * the daybook-first write order (the 20260927150000 fix).
--   * LEAST(p_credit_amount, v_available), the arrears/outstanding caps, the
--     FOR UPDATE cursor and the idempotency key v_idem.
--
-- Added: the allocation call with a NULL fallback. For all 327 pre-effective
-- advances the helper returns NULL and the function posts the single A10
-- credit it posts today.

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
  v_alloc           jsonb;
  v_funding         jsonb;
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

    -- Funding leg built once and used by BOTH branches: byte-identical to the
    -- pre-waterfall call. The wallet still gives up exactly v_take.
    v_funding := jsonb_build_array(
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
        ));

    v_alloc := public.agent_advance_allocation_entries(
                 v_adv.id, p_agent_id, v_take, now(), false);

    IF v_alloc IS NULL THEN
      PERFORM public.create_ledger_transaction(
        entries => v_funding || jsonb_build_array(
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
        )),
        idempotency_key => v_idem
      );
    ELSE
      PERFORM public.create_ledger_transaction(
        entries => v_funding || v_alloc,
        idempotency_key => v_idem
      );
    END IF;

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
