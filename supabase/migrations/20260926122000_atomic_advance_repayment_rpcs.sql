-- Blocker 3: make the agent-advance deduction and voluntary-repayment writes
-- atomic. Subledger row, ledger posting and the agent_advances balance update
-- must all commit or all roll back.
--
-- THE DEFECT
-- ----------
-- process-agent-advance-deductions writes in four separate PostgREST calls:
--   :399 insert agent_advance_ledger      (guarded, aborts cleanly)
--   :452 UPDATE agent_advances            <- the balance moves here
--   :491 penalty ledger post              (on error: logged, loop continues)
--   :585 repayment ledger post            (on error: logged, loop continues)
-- Both ledger posts happen AFTER the balance has already been reduced and
-- neither failure reverses it. This is the same shape removed from
-- cfo-record-advance-payment in Phase 0.
--
-- Measured divergence between the operational subledger and the ledger,
-- aggregated over each advance's whole life: 26 advances short by 9,776,497.20,
-- 8 advances with no repayment GL at all (4,114,874), 24 advances where the GL
-- exceeds the subledger by 3,028,687.86. Net 10,862,683.34.
--
-- voluntary-repay-advance posts the ledger first and returns 500 on failure, so
-- it cannot reduce a balance without a posting -- but its agent_advances update
-- (:121) and subledger insert (:131) are unchecked.
--
-- A SECOND DEFECT FOUND WHILE BUILDING THIS
-- -----------------------------------------
-- voluntary-repay-advance inserts its subledger row AFTER updating the advance,
-- with opening_balance = the pre-update balance. zz_guard_agent_advance_double_
-- charge then sees opening_balance > outstanding_balance and raises
-- ADVANCE_LEDGER_STALE_OPENING -- and the insert's error is never checked, so
-- the row is silently dropped. Evidence: 82 voluntary ledger legs totalling
-- 4,498,069.32, against only 19 subledger rows totalling 906,303.16.
-- record_advance_voluntary_repayment_atomic therefore writes the subledger row
-- FIRST, exactly as the deduction path does, so the guard validates against the
-- pre-deduction state and passes. Voluntary repayments start recording their
-- daybook row again. No money moves differently.
--
-- WHAT IS NOT CHANGED
-- -------------------
-- Every amount, every leg, every category, every recipient_type, every
-- idempotency key and every wallet bucket is reproduced exactly as the edge
-- functions post them today. The funding route is unchanged: wallet cash_out /
-- platform cash_in, `agent_repayment`, recipient_type 'user' and
-- 'operational_wallet'. No new wallet movement, no new external settlement, no
-- change to which advances are selected or how much is taken -- all of that
-- computation stays in the edge functions and is passed in.
--
-- Neither function carries an EXCEPTION handler. Any failure -- guard
-- rejection, solvency check, mapped-balance trigger -- aborts the whole unit.

---------------------------------------------------------------------------
-- 1. Cron / sweep deduction.
--    Write order preserved exactly as the edge function has it today:
--    subledger -> advance update -> penalty legs -> repayment legs.
---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_advance_deduction_atomic(
  p_advance_id            uuid,
  p_agent_id              uuid,
  p_date                  date,
  p_opening_balance       numeric,
  p_interest_accrued      numeric,
  p_amount_deducted       numeric,
  p_closing_balance       numeric,
  p_deduction_status      text,
  p_new_status            text,
  p_new_fee_collected     numeric,
  p_fee_status            text,
  p_new_arrears           numeric,
  p_penalty_description   text    DEFAULT NULL,
  p_penalty_meta          jsonb   DEFAULT '{}'::jsonb,
  p_repayment_description text    DEFAULT NULL,
  p_repayment_meta        jsonb   DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_penalty_group   uuid;
  v_repayment_group uuid;
BEGIN
  IF p_advance_id IS NULL OR p_agent_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'record_advance_deduction_atomic: advance, agent and date are required';
  END IF;

  -- 1. Daybook row. zz_guard_agent_advance_double_charge locks the advance and
  --    rejects a stale opening balance or an over-collection here, before
  --    anything else happens.
  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, p_date, p_opening_balance, p_interest_accrued, p_amount_deducted,
     p_closing_balance, p_deduction_status);

  -- 2. Advance row.
  UPDATE public.agent_advances
  SET outstanding_balance  = GREATEST(0, p_closing_balance),
      status               = p_new_status,
      access_fee_collected = p_new_fee_collected,
      access_fee_status    = p_fee_status,
      arrears_balance      = p_new_arrears,
      updated_at           = now()
  WHERE id = p_advance_id;

  -- 3. Penalty accrual legs, unchanged in shape from the edge function.
  IF COALESCE(p_interest_accrued, 0) > 0 THEN
    v_penalty_group := public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
          'amount', p_interest_accrued, 'category', 'agent_advance_credit',
          'recipient_type', 'user', 'wallet_bucket', 'advance_credit',
          'source_table', 'agent_advances', 'source_id', p_advance_id,
          'description', p_penalty_description,
          'currency', 'UGX', 'transaction_date', p_date,
          'metadata', p_penalty_meta
        ),
        jsonb_build_object(
          'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', p_interest_accrued, 'category', 'interest_expense',
          'source_table', 'agent_advances', 'source_id', p_advance_id,
          'description', 'Overdue advance penalty interest accrued (receivable)',
          'currency', 'UGX', 'transaction_date', p_date,
          'metadata', p_penalty_meta
        )
      ),
      idempotency_key => 'advance_penalty_interest:' || p_advance_id::text || ':' || p_date::text
    );
  END IF;

  -- 4. Repayment legs. No idempotency key, matching the edge function.
  IF COALESCE(p_amount_deducted, 0) > 0 THEN
    v_repayment_group := public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', p_amount_deducted, 'category', 'agent_repayment',
          'recipient_type', 'user',
          'source_table', 'agent_advances', 'source_id', p_advance_id,
          'description', p_repayment_description,
          'currency', 'UGX', 'transaction_date', p_date,
          'metadata', p_repayment_meta
        ),
        jsonb_build_object(
          'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', p_amount_deducted, 'category', 'agent_repayment',
          'recipient_type', 'operational_wallet',
          'source_table', 'agent_advances', 'source_id', p_advance_id,
          'description', 'Advance repayment received from agent',
          'currency', 'UGX', 'transaction_date', p_date,
          'metadata', p_repayment_meta
        )
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'amount_deducted', p_amount_deducted,
    'interest_accrued', p_interest_accrued,
    'closing_balance', GREATEST(0, p_closing_balance),
    'penalty_group_id', v_penalty_group,
    'repayment_group_id', v_repayment_group
  );
END;
$function$;

---------------------------------------------------------------------------
-- 2. Voluntary prepayment.
--    Subledger FIRST so the double-charge guard validates against the
--    pre-deduction balance (see the note above).
---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_advance_voluntary_repayment_atomic(
  p_advance_id            uuid,
  p_agent_id              uuid,
  p_date                  date,
  p_amount                numeric,
  p_opening_balance       numeric,
  p_closing_balance       numeric,
  p_new_status            text,
  p_new_fee_collected     numeric,
  p_fee_status            text,
  p_new_arrears           numeric,
  p_prepaid_remaining     integer,
  p_idempotency_key       text,
  p_wallet_description    text,
  p_meta                  jsonb   DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
BEGIN
  IF p_advance_id IS NULL OR p_agent_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'record_advance_voluntary_repayment_atomic: advance, agent and date are required';
  END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'record_advance_voluntary_repayment_atomic: amount must be greater than zero';
  END IF;

  -- 1. Daybook row first, against the pre-deduction balance.
  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, p_date, p_opening_balance, 0, p_amount,
     GREATEST(0, p_closing_balance), 'voluntary_payment');

  -- 2. Ledger legs, unchanged in shape from the edge function.
  v_group := public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', p_amount, 'category', 'agent_repayment',
        'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', p_wallet_description,
        'currency', 'UGX', 'transaction_date', p_date,
        'metadata', p_meta
      ),
      jsonb_build_object(
        'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'agent_repayment',
        'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', 'Voluntary advance repayment received',
        'currency', 'UGX', 'transaction_date', p_date,
        'metadata', p_meta
      )
    ),
    idempotency_key => p_idempotency_key
  );

  -- 3. Advance row.
  UPDATE public.agent_advances
  SET outstanding_balance            = GREATEST(0, p_closing_balance),
      status                         = p_new_status,
      access_fee_collected           = p_new_fee_collected,
      access_fee_status              = p_fee_status,
      arrears_balance                = p_new_arrears,
      prepaid_installments_remaining = p_prepaid_remaining,
      updated_at                     = now()
  WHERE id = p_advance_id;

  RETURN jsonb_build_object(
    'advance_id', p_advance_id,
    'amount_paid', p_amount,
    'closing_balance', GREATEST(0, p_closing_balance),
    'transaction_group_id', v_group
  );
END;
$function$;

---------------------------------------------------------------------------
-- 3. Both are service-role only: the sole callers are edge functions running
--    on the service key. No client path exists or should exist.
---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.record_advance_deduction_atomic(
  uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric,
  text, numeric, text, jsonb, text, jsonb)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.record_advance_voluntary_repayment_atomic(
  uuid, uuid, date, numeric, numeric, numeric, text, numeric, text, numeric,
  integer, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.record_advance_deduction_atomic(
  uuid, uuid, date, numeric, numeric, numeric, numeric, text, text, numeric,
  text, numeric, text, jsonb, text, jsonb) IS
  'Atomic unit for one agent-advance deduction: daybook row, advance balance, '
  'penalty legs and repayment legs in a single transaction with no exception '
  'handler. Called only by process-agent-advance-deductions on the service key. '
  'All selection and arithmetic stays in the caller; this posts what it is given.';

COMMENT ON FUNCTION public.record_advance_voluntary_repayment_atomic(
  uuid, uuid, date, numeric, numeric, numeric, text, numeric, text, numeric,
  integer, text, text, jsonb) IS
  'Atomic unit for one voluntary agent-advance prepayment. Writes the daybook '
  'row BEFORE the balance update so zz_guard_agent_advance_double_charge '
  'validates against the pre-deduction state -- the previous ordering had the '
  'guard silently rejecting every voluntary daybook row. Service-role only.';
