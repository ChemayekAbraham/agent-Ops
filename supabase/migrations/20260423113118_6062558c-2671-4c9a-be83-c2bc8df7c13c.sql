
CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid,
  p_tenant_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_float_balance NUMERIC;
  v_outstanding NUMERIC;
  v_txn_group UUID := gen_random_uuid();
  v_tracking_id TEXT;
  v_collection_id UUID;
  v_total_wallet NUMERIC;
  v_commission NUMERIC;
  v_landlord_id UUID;
  v_new_status TEXT;
  v_commission_earned NUMERIC;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END),0)
  INTO v_total_wallet
  FROM public.general_ledger
  WHERE user_id = p_agent_id AND ledger_scope = 'wallet';

  -- Net commission = lifetime commission credits MINUS any commission outflows.
  -- Commission outflows include explicit commission categories AND generic
  -- wallet withdrawals/transfers/deductions, since those are how agents
  -- actually take their commission out in practice.
  SELECT COALESCE(SUM(
    CASE
      WHEN direction IN ('cash_in','credit')
        AND category IN (
          'agent_commission_earned','agent_commission','agent_bonus',
          'referral_bonus','proxy_investment_commission',
          'agent_advance_credit','partner_commission'
        )
      THEN amount
      WHEN direction IN ('cash_out','debit')
        AND category IN (
          'agent_commission_withdrawal','agent_commission_used_for_rent',
          'wallet_withdrawal','wallet_transfer','wallet_deduction',
          'wallet_deduction_general_adjustment'
        )
      THEN -amount
      ELSE 0
    END),0)
  INTO v_commission
  FROM public.general_ledger
  WHERE user_id = p_agent_id AND ledger_scope = 'wallet';

  v_commission := GREATEST(0, v_commission);
  v_float_balance := GREATEST(0, v_total_wallet - v_commission);

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Float allocation blocked — would require commission funds. Available float: %s, Requested: %s, Locked commission: %s. Commission cannot be used for tenant payments.',
        v_float_balance, p_amount, v_commission
      )
    );
  END IF;

  -- Resolve landlord
  SELECT landlord_id INTO v_landlord_id
  FROM public.rent_requests
  WHERE id = p_rent_request_id;

  v_tracking_id := 'TPAY-' || to_char(now(), 'YYYYMMDD') || '-' || substring(v_txn_group::text, 1, 8);

  -- Insert collection record
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, amount, payment_method,
    float_before, float_after, tracking_id, notes
  ) VALUES (
    p_agent_id, p_tenant_id, p_amount, 'cash',
    v_float_balance, v_float_balance - p_amount, v_tracking_id, p_notes
  ) RETURNING id INTO v_collection_id;

  -- Outstanding after this allocation
  SELECT GREATEST(0, COALESCE(amount,0) - COALESCE(amount_paid,0) - p_amount)
  INTO v_outstanding
  FROM public.rent_requests WHERE id = p_rent_request_id;

  v_new_status := CASE WHEN v_outstanding <= 0 THEN 'paid' ELSE 'partial' END;

  UPDATE public.rent_requests
  SET amount_paid = COALESCE(amount_paid,0) + p_amount,
      status = v_new_status,
      updated_at = now()
  WHERE id = p_rent_request_id;

  RETURN jsonb_build_object(
    'success', true,
    'collection_id', v_collection_id,
    'tracking_id', v_tracking_id,
    'allocated', p_amount,
    'remaining_float', v_float_balance - p_amount,
    'outstanding', v_outstanding,
    'status', v_new_status
  );
END;
$function$;
