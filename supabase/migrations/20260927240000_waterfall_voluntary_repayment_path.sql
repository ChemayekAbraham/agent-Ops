-- Agent Advance waterfall, Stage E path 2 of 7:
-- record_advance_voluntary_repayment_atomic -- the agent-initiated
-- `voluntary-repay-advance` path.
--
-- NOT YET APPLIED.
--
-- The wallet funding leg is built ONCE and used by both branches, so it is
-- byte-identical in the old and new regime: one leg, for exactly p_amount,
-- same category, recipient_type, description, transaction_date and metadata.
-- The waterfall changes only how the platform side is split, never how much
-- leaves the wallet.
--
-- When agent_advance_allocation_entries returns NULL -- which it does for all
-- 327 pre-effective advances -- the function posts the single A10 credit it
-- posts today, unchanged.
--
-- The daybook-first write order introduced on 2026-09-26 is preserved: the
-- agent_advance_ledger INSERT still runs before the ledger post and before the
-- advance UPDATE, so zz_guard_agent_advance_double_charge still sees the
-- pre-payment state.
--
-- Production body before this change: 5518bee4a7880831fb8f871447caa2a6
--   (54 non-comment body lines, full definition ef514617fff7e1b660483856b388f5aa)

CREATE OR REPLACE FUNCTION public.record_advance_voluntary_repayment_atomic(p_advance_id uuid, p_agent_id uuid, p_date date, p_amount numeric, p_opening_balance numeric, p_closing_balance numeric, p_new_status text, p_new_fee_collected numeric, p_fee_status text, p_new_arrears numeric, p_prepaid_remaining integer, p_idempotency_key text, p_wallet_description text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
  v_alloc jsonb;
  v_funding jsonb;
BEGIN
  IF p_advance_id IS NULL OR p_agent_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'record_advance_voluntary_repayment_atomic: advance, agent and date are required';
  END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'record_advance_voluntary_repayment_atomic: amount must be greater than zero';
  END IF;

  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, p_date, p_opening_balance, 0, p_amount,
     GREATEST(0, p_closing_balance), 'voluntary_payment');

  v_funding := jsonb_build_array(
    jsonb_build_object(
      'user_id', p_agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
      'amount', p_amount, 'category', 'agent_repayment',
      'recipient_type', 'user',
      'source_table', 'agent_advances', 'source_id', p_advance_id,
      'description', p_wallet_description,
      'currency', 'UGX', 'transaction_date', p_date,
      'metadata', p_meta
    ));

  v_alloc := public.agent_advance_allocation_entries(
               p_advance_id, p_agent_id, p_amount, p_date::timestamptz, false);

  IF v_alloc IS NULL THEN
    v_group := public.create_ledger_transaction(
      entries => v_funding || jsonb_build_array(
        jsonb_build_object(
          'user_id', p_agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', p_amount, 'category', 'agent_repayment',
          'recipient_type', 'operational_wallet',
          'source_table', 'agent_advances', 'source_id', p_advance_id,
          'description', 'Voluntary advance repayment received',
          'currency', 'UGX', 'transaction_date', p_date,
          'metadata', p_meta
        )),
      idempotency_key => p_idempotency_key
    );
  ELSE
    v_group := public.create_ledger_transaction(
      entries => v_funding || v_alloc,
      idempotency_key => p_idempotency_key
    );
  END IF;

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
