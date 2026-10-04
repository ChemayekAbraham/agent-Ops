CREATE OR REPLACE FUNCTION public.merchant_commission_eligibility(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
  v_ident jsonb;
  v_settled boolean;
  v_evidence text;
  v_paid boolean;
  v_existing numeric;
  v_amount numeric;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'withdrawal_not_found');
  END IF;

  v_ident := public.resolve_payout_commission_agent(p_withdrawal_id);
  IF NOT coalesce((v_ident->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('eligible', false, 'reason', v_ident->>'error');
  END IF;

  -- The payout must be terminal-good. Failed / rejected / reversed never earn.
  v_paid := w.status IN ('paid', 'completed', 'disbursed');
  IF NOT v_paid THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'payout_not_paid',
                              'status', w.status, 'agent_id', v_ident->>'agent_id');
  END IF;

  -- Settlement evidence. A customer wallet debit is the cleanest proof, but
  -- payouts funded from landlord float / agent float never debit a customer
  -- wallet, so any of the following equally proves the money left:
  --   1. customer wallet debited
  --   2. the merchant's float reservation was consumed for this payout
  --   3. a payout proof document is attached
  --   4. a linked landlord payout was disbursed
  --   5. any wallet-scope settlement leg exists for this payout
  v_settled := false;
  v_evidence := NULL;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.source_id = p_withdrawal_id
      AND g.ledger_scope = 'wallet'
      AND g.user_id = w.user_id
      AND g.direction = 'cash_out'
  ) THEN
    v_settled := true; v_evidence := 'customer_wallet_debited';
  ELSIF EXISTS (
    SELECT 1 FROM public.merchant_float_reservations r
    WHERE r.withdrawal_id = p_withdrawal_id AND r.state = 'consumed'
  ) THEN
    v_settled := true; v_evidence := 'merchant_float_consumed';
  ELSIF w.payout_proof_path IS NOT NULL THEN
    v_settled := true; v_evidence := 'payout_proof_attached';
  ELSIF EXISTS (
    SELECT 1 FROM public.landlord_payouts lp
    WHERE lp.metadata->>'withdrawal_id' = p_withdrawal_id::text
      AND (lp.disbursed_at IS NOT NULL OR lp.finops_disbursed_at IS NOT NULL
           OR lp.status IN ('disbursed', 'completed', 'paid'))
  ) THEN
    v_settled := true; v_evidence := 'landlord_payout_disbursed';
  ELSIF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.source_id = p_withdrawal_id
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_out'
  ) THEN
    v_settled := true; v_evidence := 'wallet_settlement_leg';
  END IF;

  IF NOT v_settled THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'payout_settlement_unproven',
                              'agent_id', v_ident->>'agent_id');
  END IF;

  v_amount := round(coalesce(w.amount, 0) * 0.005);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'commission_rounds_to_zero',
                              'agent_id', v_ident->>'agent_id');
  END IF;

  SELECT coalesce(sum(g.amount), 0) INTO v_existing
  FROM public.general_ledger g
  WHERE g.reference_id = p_withdrawal_id::text || '-cashout-commission'
    AND g.ledger_scope = 'wallet';

  RETURN jsonb_build_object(
    'eligible', v_existing <= 0,
    'reason', CASE WHEN v_existing > 0 THEN 'already_paid' ELSE 'eligible' END,
    'settlement_evidence', v_evidence,
    'agent_id', v_ident->>'agent_id',
    'desk_id', v_ident->>'desk_id',
    'payout_amount', w.amount,
    'commission_amount', v_amount,
    'already_paid_amount', v_existing
  );
END;
$$;