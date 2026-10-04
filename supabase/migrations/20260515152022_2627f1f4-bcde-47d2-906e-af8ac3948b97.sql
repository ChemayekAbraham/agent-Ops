-- Update agent_allocate_tenant_payment to post proper revenue recognition
-- on every agent float → tenant rent allocation, with NO new wallet writes.
--
-- New ledger group per allocation:
--   1. wallet  cash_out  rent_payment_for_tenant   (full amount)   -- existing float debit
--   2. bridge  cash_out  rent_principal_collected  (principalShare) -- receivable settled
--   3. platform cash_in  rent_principal_collected  (principalShare) -- principal collected
--   4. platform cash_in  access_fee_collected      (accessShare)    -- realized fee revenue
--   5. platform cash_in  registration_fee_collected (registrationShare) -- realized fee revenue
--   6. wallet  cash_in   agent_commission_earned   (10% of full)    -- existing
--   7. platform cash_out agent_commission_payable  (10% of full)    -- existing
--
-- The wrong `rent_receivable_created cash_in` leg is REMOVED.
-- All wallet bucket movements remain identical to today (only float debit + commission credit).

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid,
  p_amount numeric, p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cached_float       numeric := 0;
  v_strict_float       numeric := 0;
  v_float_balance      numeric := 0;
  v_commission_balance numeric := 0;
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
  v_access_fee         numeric := 0;
  v_request_fee        numeric := 0;
  v_principal_share    numeric := 0;
  v_access_share       numeric := 0;
  v_registration_share numeric := 0;
  v_entries            jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id)
  VALUES (p_agent_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT
    GREATEST(0, COALESCE(float_balance, 0)),
    GREATEST(0, COALESCE(withdrawable_balance, 0))
  INTO v_cached_float, v_commission_balance
  FROM public.wallets
  WHERE user_id = p_agent_id;

  SELECT GREATEST(0, COALESCE(s.float_balance, 0))
    INTO v_strict_float
    FROM public.v_user_wallet_strict s
   WHERE s.user_id = p_agent_id;

  v_float_balance := LEAST(COALESCE(v_cached_float, 0), COALESCE(v_strict_float, 0));

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'INSUFFICIENT_FLOAT',
      'error', format(
        'Insufficient operations float. Available: %s, Requested: %s. Commission cannot be used for tenant payments.',
        v_float_balance, p_amount
      ),
      'cached_float', v_cached_float,
      'strict_float', v_strict_float
    );
  END IF;

  SELECT rr.landlord_id, l.name, rr.status,
         COALESCE(rr.total_repayment,0), COALESCE(rr.amount_repaid,0),
         COALESCE(rr.access_fee,0), COALESCE(rr.request_fee,0)
  INTO v_landlord_id, v_landlord_name, v_current_status,
       v_total_repayment, v_amount_repaid, v_access_fee, v_request_fee
  FROM public.rent_requests rr
  LEFT JOIN public.landlords l ON l.id = rr.landlord_id
  WHERE rr.id = p_rent_request_id;

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

  -- Compute proportional fee split (mirror auto-charge buildTenantRepaymentEntries)
  IF v_total_repayment > 0 THEN
    v_access_share       := round(p_amount * (v_access_fee  / v_total_repayment));
    v_registration_share := round(p_amount * (v_request_fee / v_total_repayment));
    v_principal_share    := p_amount - v_access_share - v_registration_share;
  ELSE
    v_principal_share := p_amount;
  END IF;
  IF v_principal_share < 0 THEN v_principal_share := 0; END IF;

  v_commission_earned := round(p_amount * 0.10, 2);

  v_idempotency_key := format(
    'agent_allocate_tenant_payment:%s:%s:%s:%s:%s:%s',
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount,
    extract(epoch from clock_timestamp())::text,
    gen_random_uuid()::text
  );

  -- Build entries array conditionally (skip zero-amount legs)
  v_entries := jsonb_build_array(
    -- 1. Wallet float debit (UNCHANGED — only wallet bucket write)
    jsonb_build_object(
      'user_id',p_agent_id,'amount',p_amount,'direction','cash_out',
      'category','rent_payment_for_tenant','ledger_scope','wallet',
      'classification','production',
      'description','Float allocated to tenant rent',
      'linked_party',v_landlord_id,'recipient_type','operational_wallet',
      'source_table','agent_collections','source_id',p_rent_request_id
    )
  );

  -- 2. Bridge: receivable reduction (principal portion)
  IF v_principal_share > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'user_id',p_tenant_id,'amount',v_principal_share,'direction','cash_out',
      'category','rent_principal_collected','ledger_scope','bridge',
      'classification','production',
      'description','Receivable reduction via agent float allocation',
      'linked_party',v_landlord_id,
      'source_table','agent_collections','source_id',p_rent_request_id
    ));
    -- 3. Platform: principal recognized
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'amount',v_principal_share,'direction','cash_in',
      'category','rent_principal_collected','ledger_scope','platform',
      'classification','production',
      'description','Rent principal collected via agent float',
      'source_table','agent_collections','source_id',p_rent_request_id
    ));
  END IF;

  -- 4. Platform: access fee revenue
  IF v_access_share > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'amount',v_access_share,'direction','cash_in',
      'category','access_fee_collected','ledger_scope','platform',
      'classification','production',
      'description','Access fee realized via agent float allocation',
      'source_table','agent_collections','source_id',p_rent_request_id
    ));
  END IF;

  -- 5. Platform: registration fee revenue
  IF v_registration_share > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'amount',v_registration_share,'direction','cash_in',
      'category','registration_fee_collected','ledger_scope','platform',
      'classification','production',
      'description','Registration fee realized via agent float allocation',
      'source_table','agent_collections','source_id',p_rent_request_id
    ));
  END IF;

  -- 6. Wallet: agent commission credit (UNCHANGED)
  IF v_commission_earned > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'user_id',p_agent_id,'amount',v_commission_earned,'direction','cash_in',
      'category','agent_commission_earned','ledger_scope','wallet',
      'classification','production',
      'description','10% commission on float allocation',
      'recipient_type','user',
      'source_table','agent_collections','source_id',p_rent_request_id
    ));
    -- 7. Platform: commission expense (UNCHANGED)
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'user_id',p_agent_id,'amount',v_commission_earned,'direction','cash_out',
      'category','agent_commission_payable','ledger_scope','platform',
      'classification','production',
      'description','Platform commission payout (10%)',
      'source_table','agent_collections','source_id',p_rent_request_id
    ));
  END IF;

  v_txn_group := public.create_ledger_transaction(
    v_entries, v_idempotency_key, true
  );

  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  v_new_status := CASE
    WHEN v_amount_repaid + p_amount >= v_total_repayment THEN 'completed'
    WHEN v_current_status IN ('funded','disbursed','coo_approved','agent_verified') THEN 'repaying'
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
    p_agent_id, p_tenant_id, p_amount, 'cash', v_tracking_id, p_notes,
    v_float_balance, v_float_balance - p_amount
  ) RETURNING id INTO v_collection_id;

  RETURN jsonb_build_object(
    'success', true,
    'tracking_id', v_tracking_id,
    'transaction_group', v_txn_group,
    'amount', p_amount,
    'principal_share', v_principal_share,
    'access_share', v_access_share,
    'registration_share', v_registration_share,
    'float_before', v_float_balance,
    'float_after', v_float_balance - p_amount,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned),
    'commission_earned', v_commission_earned,
    'commission_balance', v_commission_balance + v_commission_earned,
    'collection_id', v_collection_id
  );
END;
$function$;