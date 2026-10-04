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
  v_float_balance numeric;
  v_outstanding numeric;
  v_txn_group uuid := gen_random_uuid();
  v_tracking_id text;
  v_collection_id uuid;
  v_total_wallet numeric;
  v_commission numeric;
  v_landlord_id uuid;
  v_new_status text;
  v_commission_earned numeric;
  v_current_status text;
  v_total_repayment numeric;
  v_amount_repaid numeric;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END), 0)
  INTO v_total_wallet
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

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
    END
  ), 0)
  INTO v_commission
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

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

  SELECT
    landlord_id,
    status,
    COALESCE(total_repayment, 0),
    COALESCE(amount_repaid, 0),
    GREATEST(0, COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0))
  INTO
    v_landlord_id,
    v_current_status,
    v_total_repayment,
    v_amount_repaid,
    v_outstanding
  FROM public.rent_requests
  WHERE id = p_rent_request_id
    AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Amount exceeds outstanding balance of %s', v_outstanding)
    );
  END IF;

  v_tracking_id := 'TPAY-' || to_char(now(), 'YYYYMMDD') || '-' || substring(v_txn_group::text, 1, 8);
  v_commission_earned := ROUND(p_amount * 0.10);

  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
  ) VALUES (
    p_agent_id, p_amount, 'cash_out', 'agent_float_used_for_rent', 'agent_collections', p_rent_request_id,
    format('Float allocation for tenant payment — %s', v_tracking_id), 'wallet', v_txn_group
  );

  INSERT INTO public.general_ledger (
    user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
  ) VALUES (
    p_agent_id, p_amount, 'cash_in', 'tenant_repayment', 'agent_collections', p_rent_request_id,
    format('Tenant repayment via agent allocation — %s', v_tracking_id), 'platform', v_txn_group
  );

  IF v_commission_earned > 0 THEN
    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
    ) VALUES (
      p_agent_id, v_commission_earned, 'cash_in', 'agent_commission_earned', 'agent_collections', p_rent_request_id,
      format('10%% commission on float allocation — %s', v_tracking_id), 'wallet', v_txn_group
    );

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id
    ) VALUES (
      p_agent_id, v_commission_earned, 'cash_out', 'agent_commission_earned', 'agent_collections', p_rent_request_id,
      format('Platform commission expense for allocation — %s', v_tracking_id), 'platform', v_txn_group
    );
  END IF;

  v_new_status := CASE
    WHEN v_amount_repaid + p_amount >= v_total_repayment THEN 'completed'
    WHEN v_current_status IN ('funded', 'disbursed', 'coo_approved', 'agent_verified') THEN 'repaying'
    ELSE v_current_status
  END;

  UPDATE public.rent_requests
  SET amount_repaid = COALESCE(amount_repaid, 0) + p_amount,
      status = v_new_status,
      updated_at = now()
  WHERE id = p_rent_request_id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (p_tenant_id, p_rent_request_id, p_amount, now());

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, amount, payment_method, tracking_id, notes, float_before, float_after
  ) VALUES (
    p_agent_id,
    p_tenant_id,
    p_amount,
    'cash',
    v_tracking_id,
    p_notes,
    v_float_balance,
    v_float_balance - p_amount
  ) RETURNING id INTO v_collection_id;

  RETURN jsonb_build_object(
    'success', true,
    'tracking_id', v_tracking_id,
    'amount', p_amount,
    'float_before', v_float_balance,
    'float_after', v_float_balance - p_amount,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned),
    'commission_balance', v_commission,
    'collection_id', v_collection_id
  );
END;
$function$;