-- 1) Refund Forest Brian's same-day advance sweep (2026-07-14 UGX 913,500).
-- Restore the disbursement he never truly received: credit wallet withdrawable
-- and grow the advance's outstanding_balance back by the same amount.
DO $$
DECLARE
  v_agent uuid := '94ececa0-b685-4562-86c7-df6ab235a546';
  v_adv   uuid := 'd83d6e3b-755a-4259-98b3-f7b907b4462b';
  v_amt   numeric := 913500;
BEGIN
  PERFORM public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent,
        'ledger_scope', 'wallet',
        'direction', 'cash_in',
        'amount', v_amt,
        'category', 'system_balance_correction',
        'recipient_type', 'user',
        'source_table', 'agent_advances',
        'source_id', v_adv,
        'description', 'Refund: same-day advance sweep on 2026-07-14 reversed (Day-0 grace) — advance restored',
        'currency', 'UGX',
        'classification', 'admin_correction'
      ),
      jsonb_build_object(
        'user_id', v_agent,
        'ledger_scope', 'platform',
        'direction', 'cash_out',
        'amount', v_amt,
        'category', 'system_balance_correction',
        'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances',
        'source_id', v_adv,
        'description', 'Refund offset: same-day sweep reversal — Forest Brian',
        'currency', 'UGX',
        'classification', 'admin_correction'
      )
    ),
    idempotency_key => 'refund_brian_same_day_sweep_20260714'
  );

  UPDATE public.agent_advances
  SET outstanding_balance  = outstanding_balance + v_amt,
      arrears_balance      = 0,
      status               = 'active',
      access_fee_collected = 0,
      access_fee_status    = 'unpaid',
      updated_at           = now()
  WHERE id = v_adv;
END $$;

-- 2) Same-day guard on the credit-time arrears recovery. An advance issued
-- today (Africa/Kampala) is exempt from clawback until tomorrow.
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
      AND status IN ('active', 'overdue')
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
          'amount', v_take, 'category', 'agent_repayment',
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

    v_closing := v_adv.outstanding_balance - v_take;
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

    INSERT INTO public.agent_advance_ledger
      (advance_id, date, opening_balance, interest_accrued, amount_deducted, closing_balance, deduction_status)
    VALUES
      (v_adv.id, current_date, v_adv.outstanding_balance, 0, v_take, GREATEST(0, v_closing),
       CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);

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