
-- Replace recovery worker: log to system_events.metadata (no payload column exists)
CREATE OR REPLACE FUNCTION public.recover_agent_arrears_from_credit(
  p_agent_id uuid,
  p_credit_amount numeric,
  p_trigger_ledger_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  IF v_available <= 0 THEN
    RETURN 0;
  END IF;

  v_budget := LEAST(p_credit_amount, v_available);
  IF v_budget <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_adv IN
    SELECT *
    FROM public.agent_advances
    WHERE agent_id = p_agent_id
      AND status IN ('active', 'overdue')
      AND arrears_balance > 0
      AND outstanding_balance > 0
    ORDER BY issued_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_budget <= 0;

    v_take := LEAST(v_budget, v_adv.arrears_balance, v_adv.outstanding_balance);
    IF v_take <= 0 THEN
      CONTINUE;
    END IF;

    v_idem := 'arrears_recover_' || v_adv.id::text || '_'
              || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;

    PERFORM public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id,
          'ledger_scope', 'wallet',
          'direction', 'cash_out',
          'amount', v_take,
          'category', 'agent_repayment',
          'recipient_type', 'user',
          'source_table', 'agent_advances',
          'source_id', v_adv.id,
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
          'user_id', p_agent_id,
          'ledger_scope', 'platform',
          'direction', 'cash_in',
          'amount', v_take,
          'category', 'agent_repayment',
          'recipient_type', 'operational_wallet',
          'source_table', 'agent_advances',
          'source_id', v_adv.id,
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
      'warning',
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
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- audit logging must never block recovery
    END;
  END IF;

  RETURN v_recovered;
END;
$$;

-- Replace credit-time trigger: bulletproof fallback logging (metadata, swallow all)
CREATE OR REPLACE FUNCTION public.tg_recover_advance_arrears_on_earning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.ledger_scope = 'wallet'
     AND NEW.direction IN ('cash_in', 'credit')
     AND NEW.user_id IS NOT NULL
     AND NEW.amount > 0
     AND COALESCE(NEW.classification, 'production') NOT IN ('admin_correction')
     AND NEW.category IN ('agent_commission_earned', 'agent_commission')
     AND (NEW.wallet_bucket = 'withdrawable' OR NEW.wallet_bucket IS NULL OR NEW.recipient_type = 'user')
  THEN
    IF EXISTS (
      SELECT 1 FROM public.agent_advances
      WHERE agent_id = NEW.user_id
        AND status IN ('active', 'overdue')
        AND arrears_balance > 0
        AND outstanding_balance > 0
    ) THEN
      BEGIN
        PERFORM public.recover_agent_arrears_from_credit(NEW.user_id, NEW.amount, NEW.id);
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          INSERT INTO public.system_events (event_type, user_id, related_entity_type, metadata)
          VALUES (
            'repayment_failed',
            NEW.user_id,
            'agent_advance',
            jsonb_build_object(
              'source', 'arrears_credit_intercept',
              'trigger_ledger_id', NEW.id,
              'error', SQLERRM
            )
          );
        EXCEPTION WHEN OTHERS THEN
          NULL;  -- never let logging block the agent's earning
        END;
      END;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
