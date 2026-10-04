CREATE OR REPLACE FUNCTION public.withdrawal_settlement_status(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
  v_merchant uuid;
  v_wallet_debit int := 0;
  v_float numeric := 0;
  v_telecom numeric := 0;
  v_comm numeric := 0;
  v_oop numeric := 0;
  v_missing jsonb := '[]'::jsonb;
  v_legacy boolean := false;
  -- Merchant float / telecom / commission legs only began being posted here.
  v_cutoff timestamptz := '2026-07-16 00:00:00+00';
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RETURN jsonb_build_object('settled', false, 'missing', to_jsonb(ARRAY['withdrawal_not_found']));
  END IF;

  v_merchant := coalesce(w.processing_started_by, w.assigned_cashout_agent_id, w.dispatch_claimed_by);
  v_legacy := coalesce(w.processed_at, w.created_at) < v_cutoff;

  SELECT count(*) INTO v_wallet_debit
  FROM public.general_ledger
  WHERE source_table = 'withdrawal_requests'
    AND source_id = p_withdrawal_id
    AND ledger_scope = 'wallet'
    AND user_id = w.user_id
    AND direction = 'cash_out';

  SELECT coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-float-consume'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'), 0),
         coalesce(sum(amount) FILTER (WHERE reference_id = p_withdrawal_id::text || '-cashout-commission'), 0)
    INTO v_float, v_telecom, v_comm
  FROM public.general_ledger
  WHERE reference_id LIKE p_withdrawal_id::text || '-%';

  SELECT coalesce(sum(shortfall_amount), 0) INTO v_oop
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = p_withdrawal_id;

  IF v_wallet_debit = 0 THEN
    v_missing := v_missing || to_jsonb('customer_wallet_debit'::text);
  END IF;

  IF v_merchant IS NOT NULL AND NOT v_legacy THEN
    IF v_float <= 0 AND v_oop <= 0 THEN
      v_missing := v_missing || to_jsonb('merchant_float_or_out_of_pocket'::text);
    END IF;
    IF v_telecom <= 0 THEN
      v_missing := v_missing || to_jsonb('merchant_telecom_charge'::text);
    END IF;
    IF v_comm <= 0 THEN
      v_missing := v_missing || to_jsonb('merchant_commission'::text);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'withdrawal_id', p_withdrawal_id,
    'settled', jsonb_array_length(v_missing) = 0,
    'legacy', v_legacy,
    'missing', v_missing,
    'merchant_id', v_merchant,
    'customer_wallet_debit_legs', v_wallet_debit,
    'float_consumed', v_float,
    'out_of_pocket', v_oop,
    'telecom_charge', v_telecom,
    'commission', v_comm
  );
END;
$$;
