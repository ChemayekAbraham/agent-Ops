-- 1) Extend the credit limit engine: agents earn 2× of every tenant float allocation
CREATE OR REPLACE FUNCTION public.recalculate_credit_limit(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rating_bonus NUMERIC := 0;
  v_receipt_bonus NUMERIC := 0;
  v_rent_history_bonus NUMERIC := 0;
  v_landlord_rent_bonus NUMERIC := 0;
  v_houses_listed_bonus NUMERIC := 0;
  v_partners_bonus NUMERIC := 0;
  v_avg_rating NUMERIC;
  v_receipt_count INT;
  v_completed_requests INT;
  v_total_rent_collected NUMERIC;
  v_houses_count INT;
  v_partners_count INT;
  v_repayments_count INT;
  v_agent_allocations_total NUMERIC := 0;
  v_agent_allocations_bonus NUMERIC := 0;
  v_total NUMERIC;
BEGIN
  -- 1. Tenant rating bonus
  SELECT AVG(rating) INTO v_avg_rating
  FROM tenant_ratings WHERE tenant_id = p_user_id;
  IF v_avg_rating IS NOT NULL AND v_avg_rating > 3 THEN
    v_rating_bonus := ROUND((v_avg_rating - 3) * 500000);
  END IF;

  -- 2. Receipts bonus
  SELECT COUNT(*) INTO v_receipt_count
  FROM user_receipts WHERE user_id = p_user_id AND verified = true;
  v_receipt_bonus := v_receipt_count * 50000;

  -- 3. Rent request history
  SELECT COUNT(*) INTO v_completed_requests
  FROM rent_requests WHERE tenant_id = p_user_id AND status IN ('completed', 'repaid', 'disbursed', 'funded');
  v_rent_history_bonus := v_completed_requests * 200000;

  -- 4. Landlord bonus
  SELECT COALESCE(SUM(COALESCE(desired_rent_from_welile, monthly_rent, 0)), 0) INTO v_total_rent_collected
  FROM landlords WHERE registered_by = p_user_id AND tenant_id IS NOT NULL;
  v_landlord_rent_bonus := LEAST(v_total_rent_collected * 2, 10000000);

  -- 5. Houses listed bonus
  SELECT COUNT(*) INTO v_houses_count
  FROM house_listings WHERE agent_id = p_user_id;
  v_houses_listed_bonus := LEAST(v_houses_count * 50000, 5000000);

  -- 6. Partners onboarded bonus
  SELECT COUNT(*) INTO v_partners_count
  FROM investor_portfolios WHERE agent_id = p_user_id AND status IN ('active', 'completed');
  v_partners_bonus := LEAST(v_partners_count * 200000, 5000000);

  -- 7. Tenant repayment bonus (existing)
  SELECT COUNT(*) INTO v_repayments_count
  FROM general_ledger WHERE user_id = p_user_id AND category = 'rent_repayment' AND direction = 'credit';
  v_rent_history_bonus := v_rent_history_bonus + LEAST(v_repayments_count * 20000, 5000000);

  -- 8. NEW: Agent tenant-allocation bonus — every UGX paid for a tenant
  --    boosts the agent's advance limit by 2x the allocated amount.
  --    Capped at the overall ceiling (30M); applied to rent-history bucket.
  SELECT COALESCE(SUM(amount), 0) INTO v_agent_allocations_total
  FROM agent_collections WHERE agent_id = p_user_id;
  v_agent_allocations_bonus := LEAST(v_agent_allocations_total * 2, 30000000);
  v_rent_history_bonus := v_rent_history_bonus + v_agent_allocations_bonus;

  v_total := LEAST(
    30000 + v_rating_bonus + v_receipt_bonus + v_rent_history_bonus
          + v_landlord_rent_bonus + v_houses_listed_bonus + v_partners_bonus,
    30000000
  );

  INSERT INTO credit_access_limits (
    user_id, base_limit, bonus_from_ratings, bonus_from_receipts,
    bonus_from_rent_history, bonus_from_landlord_rent,
    bonus_from_houses_listed, bonus_from_partners_onboarded
  ) VALUES (
    p_user_id, 30000, v_rating_bonus, v_receipt_bonus,
    v_rent_history_bonus, v_landlord_rent_bonus,
    v_houses_listed_bonus, v_partners_bonus
  )
  ON CONFLICT (user_id) DO UPDATE SET
    bonus_from_ratings = v_rating_bonus,
    bonus_from_receipts = v_receipt_bonus,
    bonus_from_rent_history = v_rent_history_bonus,
    bonus_from_landlord_rent = v_landlord_rent_bonus,
    bonus_from_houses_listed = v_houses_listed_bonus,
    bonus_from_partners_onboarded = v_partners_bonus;

  RETURN v_total;
END;
$function$;

-- 2) Auto-recompute the agent's limit at the end of each tenant float allocation
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
  v_legs               jsonb;
  v_new_credit_limit   numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;

  SELECT GREATEST(0, COALESCE(float_balance, 0)), GREATEST(0, COALESCE(withdrawable_balance, 0))
  INTO v_cached_float, v_commission_balance FROM public.wallets WHERE user_id = p_agent_id;

  SELECT GREATEST(0, COALESCE(s.float_balance, 0)) INTO v_strict_float
    FROM public.v_user_wallet_strict s WHERE s.user_id = p_agent_id;

  v_float_balance := LEAST(COALESCE(v_cached_float, 0), COALESCE(v_strict_float, 0));

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
      'error', format('Insufficient operations float. Available: %s, Requested: %s. Commission cannot be used for tenant payments.', v_float_balance, p_amount),
      'cached_float', v_cached_float, 'strict_float', v_strict_float);
  END IF;

  SELECT rr.landlord_id, l.name, rr.status, COALESCE(rr.total_repayment,0), COALESCE(rr.amount_repaid,0)
  INTO v_landlord_id, v_landlord_name, v_current_status, v_total_repayment, v_amount_repaid
  FROM public.rent_requests rr LEFT JOIN public.landlords l ON l.id = rr.landlord_id WHERE rr.id = p_rent_request_id;

  IF v_landlord_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Rent request not found'); END IF;

  v_outstanding := GREATEST(0, v_total_repayment - v_amount_repaid);

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AMOUNT_EXCEEDS_OUTSTANDING',
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding));
  END IF;

  v_commission_earned := round(p_amount * 0.10, 2);
  v_idempotency_key := format('agent_allocate_tenant_payment:%s:%s:%s:%s:%s:%s',
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount,
    extract(epoch from clock_timestamp())::text, gen_random_uuid()::text);

  v_legs := jsonb_build_array(
    jsonb_build_object('user_id',p_agent_id,'amount',p_amount,'direction','cash_out','category','rent_payment_for_tenant','ledger_scope','wallet','classification','production','description','Float allocated to tenant rent','linked_party',v_landlord_id,'recipient_type','operational_wallet','source_table','agent_collections','source_id',p_rent_request_id),
    jsonb_build_object('user_id',p_tenant_id,'amount',p_amount,'direction','cash_in','category','rent_receivable_created','ledger_scope','bridge','classification','production','description',format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),'linked_party',v_landlord_id,'source_table','agent_collections','source_id',p_rent_request_id),
    jsonb_build_object('user_id',p_agent_id,'amount',v_commission_earned,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description','10% commission on float allocation','recipient_type','user','source_table','agent_collections','source_id',p_rent_request_id),
    jsonb_build_object('user_id',p_agent_id,'amount',v_commission_earned,'direction','cash_out','category','agent_commission_payable','ledger_scope','platform','classification','production','description','Platform commission payout (10%)','source_table','agent_collections','source_id',p_rent_request_id)
  );

  v_txn_group := public.create_ledger_transaction(v_legs, v_idempotency_key, true);

  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  v_new_status := CASE
    WHEN v_amount_repaid + p_amount >= v_total_repayment THEN 'completed'
    WHEN v_current_status IN ('funded','disbursed','coo_approved','agent_verified') THEN 'repaying'
    ELSE v_current_status
  END;

  UPDATE public.rent_requests SET amount_repaid = COALESCE(amount_repaid, 0) + p_amount,
    status = v_new_status, updated_at = now() WHERE id = p_rent_request_id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (p_tenant_id, p_rent_request_id, p_amount, now());

  INSERT INTO public.agent_collections (agent_id, tenant_id, amount, payment_method, tracking_id, notes, float_before, float_after)
  VALUES (p_agent_id, p_tenant_id, p_amount, 'cash', v_tracking_id, p_notes, v_float_balance, v_float_balance - p_amount)
  RETURNING id INTO v_collection_id;

  INSERT INTO public.agent_allocation_traces (
    agent_id, tenant_id, rent_request_id, landlord_id, amount, commission_earned,
    outstanding_before, outstanding_after, float_before, float_after,
    transaction_group, tracking_id, legs, notes
  ) VALUES (
    p_agent_id, p_tenant_id, p_rent_request_id, v_landlord_id, p_amount, v_commission_earned,
    v_outstanding, GREATEST(0, v_outstanding - p_amount), v_float_balance, v_float_balance - p_amount,
    v_txn_group, v_tracking_id, v_legs, p_notes
  );

  -- NEW: each tenant allocation grows the agent's advance access limit by 2x.
  -- Best-effort: never fail the allocation if the recompute errors.
  BEGIN
    v_new_credit_limit := public.recalculate_credit_limit(p_agent_id);
  EXCEPTION WHEN OTHERS THEN
    v_new_credit_limit := NULL;
  END;

  RETURN jsonb_build_object('success', true, 'tracking_id', v_tracking_id, 'transaction_group', v_txn_group,
    'amount', p_amount, 'float_before', v_float_balance, 'float_after', v_float_balance - p_amount,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned),
    'commission_earned', v_commission_earned,
    'commission_balance', v_commission_balance + v_commission_earned,
    'collection_id', v_collection_id,
    'new_credit_limit', v_new_credit_limit,
    'legs', v_legs);
END;
$function$;

-- 3) Backfill: recompute every agent who has ever allocated for a tenant
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL LOOP
    BEGIN
      PERFORM public.recalculate_credit_limit(r.agent_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;