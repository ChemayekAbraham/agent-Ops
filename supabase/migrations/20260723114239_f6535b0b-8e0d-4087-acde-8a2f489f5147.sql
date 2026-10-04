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
SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance      numeric := 0;
  v_outstanding        numeric;
  v_txn_group          uuid;
  v_tracking_id        text;
  v_collection_id      uuid;
  v_landlord_id        uuid;
  v_landlord_name      text;
  v_new_status         text;
  v_commission_earned  numeric;
  v_current_status     text;
  v_total_repayment    numeric;
  v_amount_repaid      numeric;
  v_idempotency_key    text;
  v_legs               jsonb;
  v_total_commission   numeric;
  v_parent_agent_id    uuid;
  v_parent_override    numeric := 0;
  v_wallet_view        jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;

  -- RENT COLLECTION FLOAT (wallet float bucket) is the sole capacity signal here.
  -- Do NOT read or deduct agent_landlord_float: that pool is only for Pay Landlord MoMo payouts.
  v_wallet_view := public.get_user_wallet_view(p_agent_id);
  v_float_balance := GREATEST(0, COALESCE((v_wallet_view ->> 'float_balance')::numeric, 0));

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'INSUFFICIENT_FLOAT',
      'error', format(
        'Insufficient wallet float. Available: %s, Requested: %s. Top up Agent Float Allocation for rent collections.',
        v_float_balance, p_amount
      ),
      'strict_float', v_float_balance,
      'cached_float', v_float_balance,
      'requested', p_amount
    );
  END IF;

  SELECT rr.landlord_id, l.name, rr.status, COALESCE(rr.total_repayment,0), COALESCE(rr.amount_repaid,0)
    INTO v_landlord_id, v_landlord_name, v_current_status, v_total_repayment, v_amount_repaid
    FROM public.rent_requests rr
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
   WHERE rr.id = p_rent_request_id
     AND rr.tenant_id = p_tenant_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  v_outstanding := GREATEST(0, v_total_repayment - v_amount_repaid);

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'AMOUNT_EXCEEDS_OUTSTANDING',
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding)
    );
  END IF;

  v_total_commission := round(p_amount * 0.10, 2);

  SELECT sa.parent_agent_id INTO v_parent_agent_id
    FROM public.agent_subagents sa
   WHERE sa.sub_agent_id = p_agent_id
     AND sa.status IN ('verified', 'approved', 'accepted')
     AND sa.parent_agent_id <> p_agent_id
   LIMIT 1;

  IF v_parent_agent_id IS NOT NULL THEN
    v_commission_earned := round(p_amount * 0.08, 2);
    v_parent_override   := v_total_commission - v_commission_earned;
  ELSE
    v_commission_earned := v_total_commission;
    v_parent_override   := 0;
  END IF;

  v_idempotency_key := format('agent_allocate_tenant_payment:%s:%s:%s:%s:%s:%s',
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount,
    extract(epoch from clock_timestamp())::text, gen_random_uuid()::text);

  -- Wallet/rent-collection float is spent here. Landlord Payout Float is untouched.
  -- Ledger legs:
  --   1. wallet cash_out   → agent_float_used_for_rent (wallet float bucket)
  --   2. bridge cash_in    → rent_receivable_created (tenant owes settled)
  --   3. wallet cash_in    → agent commission (withdrawable, recipient_type=user)
  --   4. platform cash_out → commission expense
  --   5. wallet cash_in    → parent recruiter override (if any)
  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id', p_agent_id,
      'amount', p_amount,
      'direction', 'cash_out',
      'category', 'agent_float_used_for_rent',
      'ledger_scope', 'wallet',
      'classification', 'production',
      'description', 'Tenant rent collection from agent wallet float',
      'recipient_type', 'operational_wallet',
      'wallet_bucket', 'float',
      'linked_party', v_landlord_id,
      'source_table', 'agent_collections',
      'source_id', p_rent_request_id
    ),
    jsonb_build_object(
      'user_id', p_tenant_id,
      'amount', p_amount,
      'direction', 'cash_in',
      'category', 'rent_receivable_created',
      'ledger_scope', 'bridge',
      'classification', 'production',
      'description', format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),
      'linked_party', v_landlord_id,
      'source_table', 'agent_collections',
      'source_id', p_rent_request_id
    ),
    jsonb_build_object(
      'user_id', p_agent_id,
      'amount', v_commission_earned,
      'direction', 'cash_in',
      'category', 'agent_commission_earned',
      'ledger_scope', 'wallet',
      'classification', 'production',
      'description', '10% commission on rent collection allocation',
      'recipient_type', 'user',
      'source_table', 'agent_collections',
      'source_id', p_rent_request_id
    ),
    jsonb_build_object(
      'user_id', p_agent_id,
      'amount', v_total_commission,
      'direction', 'cash_out',
      'category', 'agent_commission_payable',
      'ledger_scope', 'platform',
      'classification', 'production',
      'description', 'Platform commission payout',
      'source_table', 'agent_collections',
      'source_id', p_rent_request_id
    )
  );

  IF v_parent_agent_id IS NOT NULL AND v_parent_override > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_parent_agent_id,
        'amount', v_parent_override,
        'direction', 'cash_in',
        'category', 'agent_commission_earned',
        'ledger_scope', 'wallet',
        'classification', 'production',
        'description', '2% recruiter override on sub-agent rent collection allocation',
        'recipient_type', 'user',
        'source_table', 'agent_collections',
        'source_id', p_rent_request_id
      )
    );
  END IF;

  PERFORM public.create_ledger_transaction(v_legs, v_idempotency_key);

  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid,0) + p_amount,
         status = CASE
                    WHEN COALESCE(amount_repaid,0) + p_amount >= COALESCE(total_repayment,0)
                    THEN 'completed'
                    WHEN status IN ('disbursed', 'funded', 'approved')
                    THEN 'repaying'
                    ELSE status
                  END,
         updated_at = now()
   WHERE id = p_rent_request_id
  RETURNING status INTO v_new_status;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes
  ) VALUES (
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, 'cash'::collection_payment_method,
    v_float_balance, GREATEST(0, v_float_balance - p_amount), v_tracking_id, p_notes
  )
  RETURNING id INTO v_collection_id;

  RETURN jsonb_build_object(
    'success', true,
    'collection_id', v_collection_id,
    'transaction_group', v_txn_group,
    'tracking_id', v_tracking_id,
    'amount', p_amount,
    'amount_allocated', p_amount,
    'float_before', v_float_balance,
    'float_after', GREATEST(0, v_float_balance - p_amount),
    'wallet_float_before', v_float_balance,
    'wallet_float_after', GREATEST(0, v_float_balance - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned, 'recruiter_override', v_parent_override),
    'new_status', v_new_status,
    'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_allocate_tenant_payment(uuid, uuid, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_allocate_tenant_payment(uuid, uuid, uuid, numeric, text) TO service_role;