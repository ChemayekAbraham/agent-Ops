-- Fast, single-user strict wallet computation. Mirrors v_user_wallet_strict
-- exactly but pushes the user_id filter into the ledger scan so it uses the
-- (user_id, created_at) wallet-scope index instead of aggregating all ~70k
-- wallet legs across every user (which was hitting statement_timeout inside
-- agent_allocate_tenant_payment).
CREATE OR REPLACE FUNCTION public.user_wallet_strict(p_user_id uuid)
RETURNS TABLE(withdrawable numeric, float_balance numeric, advance_balance numeric, pending_holds numeric, total_visible numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
WITH anchor AS (
  SELECT anchor_at FROM public.wallet_fresh_start_anchors WHERE user_id = p_user_id LIMIT 1
),
ledger AS (
  SELECT gl.category, gl.direction, gl.amount, gl.wallet_bucket
  FROM public.general_ledger gl
  WHERE gl.user_id = p_user_id
    AND gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL
         OR gl.classification = 'production'
         OR (gl.classification = 'admin_correction'
             AND gl.category = 'system_balance_correction'
             AND gl.direction = ANY (ARRAY['debit','cash_out'])))
    AND (gl.created_at >= COALESCE((SELECT anchor_at FROM anchor), gl.created_at))
),
routed_explicit AS (
  SELECT l.amount,
         l.wallet_bucket AS bucket,
         CASE WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
              WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
              ELSE 0 END AS sign
  FROM ledger l
  WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
),
routed_category AS (
  SELECT l.amount, r.bucket, r.sign
  FROM ledger l
  CROSS JOIN LATERAL public.wallet_route_for_category(p_user_id, l.category, l.direction) r(bucket, sign)
  WHERE l.wallet_bucket IS NULL
),
routed AS (
  SELECT amount, bucket, sign FROM routed_explicit
  UNION ALL
  SELECT amount, bucket, sign FROM routed_category
),
buckets AS (
  SELECT
    SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END) AS withdrawable_raw,
    SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END) AS float_raw,
    SUM(CASE WHEN bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN sign::numeric * amount ELSE 0 END) AS advance_raw
  FROM routed
),
holds AS (
  SELECT COALESCE(SUM(wr.amount), 0) AS pending_holds
  FROM public.withdrawal_requests wr
  WHERE (CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id ELSE wr.user_id END) = p_user_id
    AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet' AND g.direction = ANY (ARRAY['cash_out','debit']))
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
)
SELECT
  GREATEST(0, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0)) AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw,0)) AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw,0)) AS advance_balance,
  COALESCE(h.pending_holds,0) AS pending_holds,
  GREATEST(0, COALESCE(b.withdrawable_raw,0) - COALESCE(h.pending_holds,0)) + GREATEST(0, COALESCE(b.float_raw,0)) AS total_visible
FROM buckets b CROSS JOIN holds h;
$fn$;

GRANT EXECUTE ON FUNCTION public.user_wallet_strict(uuid) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(p_agent_id uuid, p_rent_request_id uuid, p_amount numeric, p_description text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cached_float           numeric := 0;
  v_strict_float           numeric := 0;
  v_float_balance          numeric := 0;
  v_has_wallet             boolean := false;
  v_landlord_id            uuid;
  v_current_status         text;
  v_total_repayment        numeric;
  v_amount_repaid          numeric;
  v_outstanding            numeric;
  v_commission_amt         numeric;
  v_txn_group              uuid;
  v_tracking_id            text;
  v_now                    timestamptz := now();
BEGIN
  SELECT GREATEST(0, COALESCE(w.float_balance, 0)), true
    INTO v_cached_float, v_has_wallet
    FROM public.wallets w
   WHERE w.user_id = p_agent_id;

  SELECT GREATEST(0, COALESCE(s.float_balance, 0))
    INTO v_strict_float
    FROM public.user_wallet_strict(p_agent_id) s;

  -- Strict ledger pivot is the ceiling. Cached can only further reduce it.
  IF v_has_wallet THEN
    v_float_balance := LEAST(v_cached_float, COALESCE(v_strict_float, 0));
  ELSE
    v_float_balance := COALESCE(v_strict_float, 0);
  END IF;

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'INSUFFICIENT_FLOAT',
      'error', format(
        'Insufficient float. Available: UGX %s, Requested: UGX %s. Top up your float to continue.',
        v_float_balance, p_amount
      ),
      'cached_float', v_cached_float,
      'strict_float', v_strict_float
    );
  END IF;

  SELECT
    landlord_id,
    status,
    COALESCE(total_repayment, 0),
    COALESCE(amount_repaid, 0),
    GREATEST(0, COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0))
  INTO
    v_landlord_id, v_current_status, v_total_repayment, v_amount_repaid, v_outstanding
  FROM public.rent_requests
  WHERE id = p_rent_request_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object('success', false,
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding));
  END IF;

  v_commission_amt := round(p_amount * 0.10);
  v_txn_group      := gen_random_uuid();
  v_tracking_id    := substr(v_txn_group::text, 1, 8);

  PERFORM public.create_ledger_transaction(
    'agent_tenant_float_allocation',
    jsonb_build_array(
      jsonb_build_object('user_id',p_agent_id,'amount',p_amount,'direction','cash_out','category','rent_payment_for_tenant','ledger_scope','wallet','classification','production','description',COALESCE(p_description, format('Float allocated to tenant rent — %s', v_tracking_id)),'linked_party',v_landlord_id,'reference_id',v_txn_group::text,'recipient_type','operational_wallet'),
      jsonb_build_object('user_id',v_landlord_id,'amount',p_amount,'direction','cash_in','category','rent_payment_received','ledger_scope','wallet','classification','production','description','Tenant rent received via agent float','linked_party',p_agent_id,'reference_id',v_txn_group::text,'recipient_type','user'),
      jsonb_build_object('user_id',p_agent_id,'amount',v_commission_amt,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description',format('10%% commission on float allocation — %s', v_tracking_id),'reference_id',v_txn_group::text,'recipient_type','user'),
      jsonb_build_object('user_id',p_agent_id,'amount',v_commission_amt,'direction','cash_out','category','agent_commission_payable','ledger_scope','platform','classification','production','description','Platform commission payout (10%)','reference_id',v_txn_group::text)
    )
  );

  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid, 0) + p_amount,
         status = CASE WHEN COALESCE(amount_repaid, 0) + p_amount >= COALESCE(total_repayment, 0) THEN 'completed' ELSE status END,
         updated_at = v_now
   WHERE id = p_rent_request_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_group', v_txn_group,
    'commission_earned', v_commission_amt,
    'amount_allocated',  p_amount
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text)
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
  v_total_commission   numeric;
  v_parent_agent_id    uuid;
  v_parent_override    numeric := 0;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;

  SELECT GREATEST(0, COALESCE(float_balance, 0)), GREATEST(0, COALESCE(withdrawable_balance, 0))
  INTO v_cached_float, v_commission_balance FROM public.wallets WHERE user_id = p_agent_id;

  SELECT GREATEST(0, COALESCE(s.float_balance, 0)) INTO v_strict_float
    FROM public.user_wallet_strict(p_agent_id) s;

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

  v_legs := jsonb_build_array(
    jsonb_build_object('user_id',p_agent_id,'amount',p_amount,'direction','cash_out','category','rent_payment_for_tenant','ledger_scope','wallet','classification','production','description','Float allocated to tenant rent','linked_party',v_landlord_id,'recipient_type','operational_wallet','source_table','agent_collections','source_id',p_rent_request_id),
    jsonb_build_object('user_id',p_tenant_id,'amount',p_amount,'direction','cash_in','category','rent_receivable_created','ledger_scope','bridge','classification','production','description',format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),'linked_party',v_landlord_id,'source_table','agent_collections','source_id',p_rent_request_id),
    jsonb_build_object('user_id',p_agent_id,'amount',v_commission_earned,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description','10% commission on float allocation','recipient_type','user','source_table','agent_collections','source_id',p_rent_request_id),
    jsonb_build_object('user_id',p_agent_id,'amount',v_total_commission,'direction','cash_out','category','agent_commission_payable','ledger_scope','platform','classification','production','description','Platform commission payout','source_table','agent_collections','source_id',p_rent_request_id)
  );

  IF v_parent_agent_id IS NOT NULL AND v_parent_override > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object('user_id',v_parent_agent_id,'amount',v_parent_override,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description','2% recruiter override on sub-agent allocation','recipient_type','user','source_table','agent_collections','source_id',p_rent_request_id)
    );
  END IF;

  PERFORM public.create_ledger_transaction('agent_tenant_float_allocation', v_legs);

  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid,0) + p_amount,
         status = CASE WHEN COALESCE(amount_repaid,0) + p_amount >= COALESCE(total_repayment,0) THEN 'completed' ELSE status END,
         updated_at = now()
   WHERE id = p_rent_request_id
  RETURNING status INTO v_new_status;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := substr(v_txn_group::text, 1, 8);

  RETURN jsonb_build_object(
    'success', true,
    'transaction_group', v_txn_group,
    'tracking_id', v_tracking_id,
    'amount_allocated', p_amount,
    'commission', jsonb_build_object('credited_commission', v_commission_earned, 'recruiter_override', v_parent_override),
    'new_status', v_new_status,
    'outstanding_before', v_outstanding,
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name
  );
END;
$function$;