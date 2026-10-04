
-- ============================================================================
-- 1. Arrears tracking columns on agent_advances
-- ============================================================================
ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS arrears_balance numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_installment numeric NOT NULL DEFAULT 0;

-- Backfill the scheduled daily installment for all advances.
UPDATE public.agent_advances
SET daily_installment = CASE
      WHEN cycle_days > 0 THEN round((principal + COALESCE(access_fee, 0)) / cycle_days)
      ELSE 0 END
WHERE daily_installment = 0;

-- ============================================================================
-- 2. Safety trigger: keep arrears sane on every write to agent_advances
--    (arrears never exceed outstanding; cleared once the advance is settled)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tg_cap_advance_arrears()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'completed' OR NEW.outstanding_balance <= 0 THEN
    NEW.arrears_balance := 0;
  ELSIF NEW.arrears_balance > NEW.outstanding_balance THEN
    NEW.arrears_balance := NEW.outstanding_balance;
  END IF;
  IF NEW.arrears_balance < 0 THEN
    NEW.arrears_balance := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cap_advance_arrears ON public.agent_advances;
CREATE TRIGGER trg_cap_advance_arrears
  BEFORE INSERT OR UPDATE ON public.agent_advances
  FOR EACH ROW EXECUTE FUNCTION public.tg_cap_advance_arrears();

-- ============================================================================
-- 3. Seed arrears for existing active/overdue advances so recovery starts now.
--    arrears = (scheduled-to-date) - (already paid), capped at [0, outstanding].
-- ============================================================================
UPDATE public.agent_advances a
SET arrears_balance = LEAST(
  a.outstanding_balance,
  GREATEST(
    0,
    LEAST(
      (a.principal + COALESCE(a.access_fee, 0)),
      FLOOR(EXTRACT(EPOCH FROM (now() - a.issued_at)) / 86400)
        * (CASE WHEN a.cycle_days > 0
                THEN round((a.principal + COALESCE(a.access_fee, 0)) / a.cycle_days)
                ELSE 0 END)
    )
    - ((a.principal + COALESCE(a.access_fee, 0)) - a.outstanding_balance)
  )
)
WHERE a.status IN ('active', 'overdue')
  AND a.outstanding_balance > 0;

-- ============================================================================
-- 4. Recovery worker: pull arrears out of an incoming earning (FIFO by advance)
--    Balanced double-entry via create_ledger_transaction with Wallet Routing v2.
-- ============================================================================
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

  -- STRICT withdrawable snapshot (already includes the incoming credit).
  -- Never read wallets.balance — float / commission custody is untouchable.
  v_available := COALESCE(public.get_user_available_balance(p_agent_id), 0);
  IF v_available <= 0 THEN
    RETURN 0;
  END IF;

  -- Never recover more than what just came in, nor more than is withdrawable now.
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
    ORDER BY issued_at ASC   -- oldest missed debt first (FIFO)
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
    -- Tell the agent exactly what was taken and why.
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

    INSERT INTO public.system_events (event_type, payload)
    VALUES (
      'repayment_successful',
      jsonb_build_object(
        'source', 'arrears_credit_intercept',
        'user_id', p_agent_id,
        'amount', v_recovered,
        'trigger_ledger_id', p_trigger_ledger_id
      )
    );
  END IF;

  RETURN v_recovered;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_agent_arrears_from_credit(uuid, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recover_agent_arrears_from_credit(uuid, numeric, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recover_agent_arrears_from_credit(uuid, numeric, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recover_agent_arrears_from_credit(uuid, numeric, uuid) TO service_role;

-- ============================================================================
-- 5. Credit-time trigger: intercept incoming agent earnings for arrears recovery
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tg_recover_advance_arrears_on_earning()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only genuine agent earnings that increase the withdrawable bucket.
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
        -- A recovery failure must NEVER block the agent's earning from posting.
        INSERT INTO public.system_events (event_type, payload)
        VALUES (
          'repayment_failed',
          jsonb_build_object(
            'source', 'arrears_credit_intercept',
            'user_id', NEW.user_id,
            'trigger_ledger_id', NEW.id,
            'error', SQLERRM
          )
        );
      END;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recover_advance_arrears_on_earning ON public.general_ledger;
CREATE TRIGGER trg_recover_advance_arrears_on_earning
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_recover_advance_arrears_on_earning();
