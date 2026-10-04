-- Forward-only correction of the tenant-payment posting shape.
-- A tenant payment now: DR A5 cash_receipt_in_transit (custody rises once)
--                       CR A3 tenant_repayment_collected (receivable falls once)
-- Agent float (A2) is NOT a leg of a collection. Bank (A1) is not touched.
-- Commission legs are unchanged. No historical row is read, rewritten or reversed.
CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment_internal(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_client_ref uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance numeric := 0; v_outstanding numeric; v_txn_group uuid; v_tracking_id text;
  v_collection_id uuid; v_landlord_id uuid; v_landlord_name text; v_new_status text;
  v_commission_earned numeric; v_current_status text; v_total_repayment numeric;
  v_amount_repaid numeric; v_idempotency_key text; v_legs jsonb; v_total_commission numeric;
  v_parent_agent_id uuid; v_parent_override numeric := 0; v_wallet_view jsonb;
  v_whitelisted boolean := false; v_fee jsonb := jsonb_build_object('status','not_attempted');
  v_treasury jsonb := jsonb_build_object('status','not_attempted');
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;

  v_wallet_view := public.get_user_wallet_view(p_agent_id);
  v_float_balance := GREATEST(0, COALESCE((v_wallet_view ->> 'float_balance')::numeric, 0));

  -- Unchanged eligibility control: an agent must still hold float cover to
  -- record a collection. Float is an allowance (amount due from agents), so it
  -- is a gate only — it is no longer consumed as if it were physical cash.
  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
      'error', format('Insufficient wallet float. Available: %s, Requested: %s. Top up Agent Float Allocation for rent collections.',
        v_float_balance, p_amount),
      'strict_float', v_float_balance, 'cached_float', v_float_balance, 'requested', p_amount);
  END IF;

  SELECT rr.landlord_id, l.name, rr.status, COALESCE(rr.total_repayment,0), COALESCE(rr.amount_repaid,0)
    INTO v_landlord_id, v_landlord_name, v_current_status, v_total_repayment, v_amount_repaid
    FROM public.rent_requests rr LEFT JOIN public.landlords l ON l.id = rr.landlord_id
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

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
     AND sa.parent_agent_id <> p_agent_id LIMIT 1;

  v_whitelisted := public.is_subagent_commission_whitelisted(p_agent_id);

  IF v_parent_agent_id IS NOT NULL AND NOT v_whitelisted THEN
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
    -- DR A5: the tenant's cash is now held in custody, not yet banked.
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_in',
      'category', 'cash_receipt_in_transit', 'ledger_scope', 'platform', 'classification', 'production',
      'account', 'platform:cash_in_transit',
      'description', 'Tenant rent cash received by agent — held in custody, not yet banked',
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    -- CR A3: the tenant receivable falls by exactly the amount collected.
    jsonb_build_object('user_id', p_tenant_id, 'amount', p_amount, 'direction', 'cash_out',
      'category', 'tenant_repayment_collected', 'ledger_scope', 'platform', 'classification', 'production',
      'description', format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_agent_id, 'amount', v_commission_earned, 'direction', 'cash_in',
      'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', CASE WHEN v_whitelisted AND v_parent_agent_id IS NOT NULL
                          THEN 'Full 10% commission on rent collection (whitelisted sub-agent)'
                          ELSE '10% commission on rent collection allocation' END,
      'recipient_type', 'user', 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_agent_id, 'amount', v_total_commission, 'direction', 'cash_out',
      'category', 'agent_commission_payable', 'ledger_scope', 'platform', 'classification', 'production',
      'description', 'Platform commission payout',
      'source_table', 'agent_collections', 'source_id', p_rent_request_id)
  );

  IF v_parent_agent_id IS NOT NULL AND v_parent_override > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object('user_id', v_parent_agent_id, 'amount', v_parent_override, 'direction', 'cash_in',
        'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'classification', 'production',
        'description', '2% recruiter override on sub-agent rent collection allocation',
        'recipient_type', 'user', 'source_table', 'agent_collections', 'source_id', p_rent_request_id));
  END IF;

  PERFORM public.create_ledger_transaction(v_legs, v_idempotency_key);

  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid,0) + p_amount,
         status = CASE WHEN COALESCE(amount_repaid,0) + p_amount >= COALESCE(total_repayment,0) THEN 'completed'
                       WHEN status IN ('disbursed', 'funded', 'approved') THEN 'repaying'
                       ELSE status END,
         updated_at = now()
   WHERE id = p_rent_request_id RETURNING status INTO v_new_status;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  -- float_before = float_after: a collection no longer consumes float.
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes, client_ref
  ) VALUES (
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, 'cash'::collection_payment_method,
    v_float_balance, v_float_balance, v_tracking_id, p_notes, p_client_ref
  ) RETURNING id INTO v_collection_id;

  BEGIN
    v_fee := public.post_rent_fee_collection(
      p_rent_request_id, p_amount, 'agent_collections', v_collection_id);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.rent_fee_collection_exceptions
        (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
      VALUES (p_rent_request_id, v_collection_id, 'agent_collections', p_amount,
              'fee_posting_failed', jsonb_build_object('sqlerrm', left(SQLERRM, 400)))
      ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_fee := jsonb_build_object('status','error','detail', left(SQLERRM, 200));
  END;

  -- post_treasury_fee_cash_transfer is deliberately NOT called any more.
  -- It existed to move the fee portion of the cash out of the agent's A2
  -- custody into A5. Under the corrected shape the whole collection already
  -- lands in A5 and never sits in A2, so calling it would double-count custody
  -- and wrongly reduce Agent Float.
  v_treasury := jsonb_build_object('status','skipped_custody_posted_at_collection',
    'reason', 'Full collection recorded in A5 cash custody at the moment of payment');

  RETURN jsonb_build_object(
    'success', true, 'collection_id', v_collection_id, 'transaction_group', v_txn_group,
    'tracking_id', v_tracking_id, 'amount', p_amount, 'amount_allocated', p_amount,
    'float_before', v_float_balance, 'float_after', v_float_balance,
    'wallet_float_before', v_float_balance, 'wallet_float_after', v_float_balance,
    'commission', jsonb_build_object('credited_commission', v_commission_earned,
      'recruiter_override', v_parent_override, 'full_commission_whitelisted', v_whitelisted),
    'fee_allocation', v_fee, 'treasury_transfer', v_treasury, 'client_ref', p_client_ref,
    'new_status', v_new_status, 'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name);
END;
$function$;

-- Reporting: expose company cash available to spend (A1 only) separately from
-- cash in custody that has not been confirmed banked (A5). total_cash is kept
-- unchanged for existing callers.
CREATE OR REPLACE FUNCTION public.get_treasury_cash_position(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_a1 numeric := 0;
  v_a5 numeric := 0;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the treasury cash position';
  END IF;

  WITH legs AS MATERIALIZED (
    SELECT gl.category,
           gl.direction,
           gl.amount,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS account_code,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS debit_when
    FROM general_ledger gl
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE (gl.classification IN ('production','legacy_real')
             OR (gl.classification = 'admin_correction'
                 AND gl.source_table = 'merchant_float_reconciliations'))
      AND gl.transaction_date <= p_as_at
  ), cash AS (
    SELECT account_code, category,
           CASE WHEN direction = debit_when THEN amount ELSE 0 END AS dr,
           CASE WHEN direction = debit_when THEN 0 ELSE amount END AS cr
    FROM legs
    WHERE account_code IN ('A1','A5')
  ), bal AS (
    SELECT account_code, SUM(dr) - SUM(cr) AS net FROM cash GROUP BY 1
  ), by_cat AS (
    SELECT category,
           SUM(dr) AS dr,
           SUM(cr) AS cr,
           COUNT(*) AS entry_count
    FROM cash
    GROUP BY 1
  )
  SELECT
    COALESCE((SELECT net FROM bal WHERE account_code = 'A1'), 0),
    COALESCE((SELECT net FROM bal WHERE account_code = 'A5'), 0),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'category', category,
               'debits', ROUND(dr),
               'credits', ROUND(cr),
               'net', ROUND(dr - cr),
               'entry_count', entry_count
             ) ORDER BY abs(dr - cr) DESC)
      FROM by_cat
    ), '[]'::jsonb)
  INTO v_a1, v_a5, v_lines;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'a1_cash_and_bank', ROUND(v_a1),
    'a5_cash_in_transit', ROUND(v_a5),
    'total_cash', ROUND(v_a1 + v_a5),
    'available_company_cash', ROUND(v_a1),
    'custody_not_confirmed_banked', ROUND(v_a5),
    'custody_caption', 'Cash in Custody — Not Yet Confirmed Banked',
    'lines', v_lines,
    'source', 'general_ledger trial balance — A1 Cash and Bank (available) and A5 cash in custody, not yet confirmed banked'
  );
END;
$function$;