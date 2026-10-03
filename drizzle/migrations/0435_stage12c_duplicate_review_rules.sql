CREATE OR REPLACE FUNCTION public.fin_s12_assert_controls()
 RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE n int; a numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount),0) INTO n, a FROM public.fin_collection_reconciliation_s11;
  IF n <> 659 OR a <> 56946270 THEN RAISE EXCEPTION 'Stage 11 control total changed (% / UGX %) — evidence save refused', n, a; END IF;
  SELECT count(*), coalesce(sum(amount),0) INTO n, a FROM public.fin_collection_reconciliation_s11 WHERE reconciliation_result='System-inconsistent';
  IF n <> 14 OR a <> 1684334 THEN RAISE EXCEPTION 'Agent-mismatch queue changed (% / UGX %) — evidence save refused', n, a; END IF;
  SELECT count(*), coalesce(sum(amount),0) INTO n, a FROM public.fin_collection_reconciliation_s11 WHERE reconciliation_result='System duplicate candidate';
  IF n <> 253 OR a <> 23231059 THEN RAISE EXCEPTION 'Duplicate-candidate population changed (% / UGX %) — evidence save refused', n, a; END IF;
  SELECT count(*) INTO n FROM public.fin_collection_reconciliation_s11 r JOIN public.agent_collections c ON c.id=r.collection_id
   WHERE c.amount=r.amount AND c.agent_id=r.agent_id AND c.reversed_at IS NOT DISTINCT FROM r.reversed_at AND c.rent_request_id IS NOT DISTINCT FROM r.rent_plan_id;
  IF n <> 659 THEN RAISE EXCEPTION 'Collections no longer match Stage 11 (% of 659) — evidence save refused', n; END IF;
END $f$;
CREATE OR REPLACE FUNCTION public.cfo_s12_list()
 RETURNS TABLE(collection_id uuid, collected_at timestamp with time zone, agent_id uuid, agent_name text, tenant_name text, rent_plan_id uuid, plan_agent_id uuid, plan_agent_name text, amount numeric, original_classification text, reconciliation_result text, ledger_group text, ledger_receipt numeric, ledger_repayment numeric, ledger_commission numeric, access_fee numeric, registration_fee numeric, reversed_at timestamp with time zone, findings text, evidence jsonb, matches jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY
  SELECT s.collection_id, s.collected_at, s.agent_id, s.agent_name, s.tenant_name, s.rent_plan_id,
    rr.agent_id, pa.full_name, s.amount, s.original_classification, s.reconciliation_result,
    s.ledger_group, s.ledger_receipt, s.ledger_repayment, s.ledger_commission, s.access_fee, s.registration_fee,
    s.reversed_at, s.findings, to_jsonb(e) - 'collection_id',
    CASE WHEN s.dup_matches > 0 THEN (
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'collected_at', o.created_at, 'agent_id', o.agent_id, 'agent_name', s.agent_name, 'tenant_name', s.tenant_name, 'rent_plan_id', o.rent_request_id, 'amount', o.amount,
        'seconds_apart', round(extract(epoch FROM o.created_at - s.collected_at)), 'reversed_at', o.reversed_at,
        'in_population', EXISTS (SELECT 1 FROM public.fin_collection_reconciliation_s11 x WHERE x.collection_id = o.id)) ORDER BY o.created_at)
      FROM public.agent_collections o
      WHERE o.id <> s.collection_id AND o.agent_id = s.agent_id AND o.tenant_id IS NOT DISTINCT FROM s.tenant_id
        AND o.rent_request_id IS NOT DISTINCT FROM s.rent_plan_id AND o.amount = s.amount
        AND abs(extract(epoch FROM o.created_at - s.collected_at)) <= 1800) END
  FROM public.fin_collection_reconciliation_s11 s
  JOIN public.fin_collection_evidence_s12 e ON e.collection_id = s.collection_id
  LEFT JOIN public.rent_requests rr ON rr.id = s.rent_plan_id
  LEFT JOIN public.profiles pa ON pa.id = rr.agent_id
  ORDER BY s.collected_at;
END $function$;
CREATE OR REPLACE FUNCTION public.cfo_s12_case_evidence(p_collection_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_in boolean; s public.fin_collection_reconciliation_s11%ROWTYPE; c public.agent_collections%ROWTYPE; v_plan_agent uuid; v_phone text; r jsonb;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO s FROM public.fin_collection_reconciliation_s11 WHERE collection_id = p_collection_id;
  v_in := FOUND;
  SELECT * INTO c FROM public.agent_collections WHERE id = p_collection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection not found'; END IF;
  IF NOT v_in THEN
    IF NOT EXISTS (SELECT 1 FROM public.fin_collection_reconciliation_s11 x WHERE x.reconciliation_result = 'System duplicate candidate'
        AND x.agent_id = c.agent_id AND x.tenant_id IS NOT DISTINCT FROM c.tenant_id AND x.rent_plan_id IS NOT DISTINCT FROM c.rent_request_id
        AND x.amount = c.amount AND abs(extract(epoch FROM c.created_at - x.collected_at)) <= 1800) THEN
      RAISE EXCEPTION 'Collection is not in the Stage 11 population or a listed possible match';
    END IF;
    s.agent_id := c.agent_id; s.tenant_id := c.tenant_id; s.rent_plan_id := c.rent_request_id; s.ledger_group := NULL;
  END IF;
  SELECT agent_id INTO v_plan_agent FROM public.rent_requests WHERE id = s.rent_plan_id;
  SELECT phone INTO v_phone FROM public.profiles WHERE id = s.tenant_id;
  SELECT jsonb_build_object(
    'in_population', v_in, 'recorded_agent_id', s.agent_id, 'tenant_name', (SELECT full_name FROM public.profiles WHERE id = c.tenant_id), 'rent_plan_id', c.rent_request_id, 'amount', c.amount, 'agent_name', (SELECT full_name FROM public.profiles WHERE id = c.agent_id), 'reversed_at', c.reversed_at, 'plan_agent_id', v_plan_agent,
    'collection', jsonb_build_object('tracking_id', c.tracking_id, 'payment_method', c.payment_method, 'channel', c.collection_channel,
       'momo_provider', c.momo_provider, 'momo_phone', c.momo_phone, 'momo_payer_name', c.momo_payer_name, 'momo_transaction_id', c.momo_transaction_id,
       'notes', c.notes, 'location_name', c.location_name, 'sms_sent_agent', c.sms_sent_agent, 'sms_sent_tenant', c.sms_sent_tenant,
       'float_before', c.float_before, 'float_after', c.float_after, 'client_ref', c.client_ref, 'deposit_request_id', c.deposit_request_id,
       'initiated_by', c.initiated_by, 'initiated_by_name', (SELECT full_name FROM public.profiles WHERE id = c.initiated_by), 'created_at', c.created_at),
    'agent_receipts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ar.id, 'agent_id', ar.agent_id, 'agent_name', p.full_name, 'payer_name', ar.payer_name,
       'payer_phone', ar.payer_phone, 'amount', ar.amount, 'method', ar.payment_method, 'transaction_id', ar.transaction_id,
       'image_url', ar.receipt_image_url, 'notes', ar.notes, 'created_at', ar.created_at) ORDER BY ar.created_at)
       FROM public.agent_receipts ar LEFT JOIN public.profiles p ON p.id = ar.agent_id
       WHERE ar.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days'
         AND ((ar.agent_id IN (s.agent_id, v_plan_agent) AND ar.amount = c.amount)
              OR (v_phone IS NOT NULL AND right(regexp_replace(coalesce(ar.payer_phone,''),'\D','','g'),9) = right(regexp_replace(v_phone,'\D','','g'),9)))), '[]'::jsonb),
    'tenant_receipts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ur.id, 'receipt_number_id', ur.receipt_number_id, 'description', ur.items_description,
       'amount', ur.claimed_amount, 'verified', ur.verified, 'verified_at', ur.verified_at, 'created_at', ur.created_at) ORDER BY ur.created_at)
       FROM public.user_receipts ur WHERE ur.user_id = s.tenant_id AND ur.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days'), '[]'::jsonb),
    'deposits', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'user_id', d.user_id, 'user_name', p.full_name, 'agent_id', d.agent_id, 'amount', d.amount,
       'status', d.status, 'provider', d.provider, 'transaction_id', d.transaction_id, 'transaction_date', d.transaction_date, 'purpose', d.deposit_purpose,
       'notes', d.notes, 'created_at', d.created_at, 'linked', d.id = c.deposit_request_id) ORDER BY d.created_at)
       FROM public.deposit_requests d LEFT JOIN public.profiles p ON p.id = d.user_id
       WHERE d.id = c.deposit_request_id
          OR ((d.user_id IN (s.agent_id, v_plan_agent) OR d.agent_id IN (s.agent_id, v_plan_agent)) AND d.amount = c.amount
              AND d.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days')), '[]'::jsonb),
    'visits', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'agent_id', v.agent_id, 'agent_name', p.full_name, 'latitude', v.latitude, 'longitude', v.longitude,
       'accuracy', v.accuracy, 'location_name', v.location_name, 'checked_in_at', v.checked_in_at,
       'same_instant', abs(extract(epoch FROM v.created_at - c.created_at)) < 2) ORDER BY v.created_at)
       FROM public.agent_visits v LEFT JOIN public.profiles p ON p.id = v.agent_id
       WHERE v.tenant_id = s.tenant_id AND v.created_at BETWEEN c.created_at - interval '2 days' AND c.created_at + interval '2 days'), '[]'::jsonb),
    'ledger', coalesce((SELECT jsonb_agg(jsonb_build_object('direction', g.direction, 'category', g.category, 'amount', g.amount, 'bucket', g.wallet_bucket,
       'user_id', g.user_id, 'user_name', p.full_name, 'description', g.description, 'created_at', g.created_at) ORDER BY g.created_at)
       FROM public.general_ledger g LEFT JOIN public.profiles p ON p.id = g.user_id WHERE g.transaction_group_id::text = s.ledger_group OR g.source_id = p_collection_id), '[]'::jsonb),
    'files', coalesce((SELECT jsonb_agg(jsonb_build_object('path', so.name, 'size', so.metadata->>'size', 'uploaded_at', so.created_at) ORDER BY so.created_at)
       FROM storage.objects so WHERE so.bucket_id = 'collection-evidence' AND so.name LIKE p_collection_id::text || '/%'), '[]'::jsonb)
  ) INTO r;
  RETURN r;
END $function$;
CREATE OR REPLACE FUNCTION public.cfo_s12_save_evidence(p_collection_id uuid, p_status text, p_reason text, p_fields jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fin bigint; v_prev text; v_orig uuid; v_agent uuid; v_ready text; v_path text; v_n int; v_a numeric;
  s public.fin_collection_reconciliation_s11%ROWTYPE; o public.agent_collections%ROWTYPE;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT count(*), coalesce(sum(r.amount),0) INTO v_n, v_a FROM public.fin_collection_evidence_s12 e JOIN public.fin_collection_reconciliation_s11 r USING (collection_id);
  IF v_n <> 659 OR v_a <> 56946270 THEN RAISE EXCEPTION 'Stage 12 does not reconcile to 659 / UGX 56,946,270 — evidence decisions are locked'; END IF;
  IF p_status NOT IN ('Pending Evidence','Confirmed Genuine','Confirmed Duplicate','Confirmed Agent Mismatch','Valid Separate Payment','Unresolved') THEN RAISE EXCEPTION 'Unknown status'; END IF;
  IF length(coalesce(trim(p_reason),'')) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  PERFORM public.fin_s12_assert_controls();
  v_fin := public.fin_s12_txn_financial_writes();
  IF v_fin <> 0 THEN RAISE EXCEPTION 'Financial records were already written in this transaction — evidence save refused'; END IF;
  SELECT evidence_status INTO v_prev FROM public.fin_collection_evidence_s12 WHERE collection_id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection is not in the Stage 11 population'; END IF;
  SELECT * INTO s FROM public.fin_collection_reconciliation_s11 WHERE collection_id = p_collection_id;

  IF s.reconciliation_result = 'System-inconsistent' AND p_status NOT IN ('Confirmed Agent Mismatch','Confirmed Genuine','Unresolved') THEN
    RAISE EXCEPTION 'Agent-mismatch cases may only be Confirmed Agent Mismatch, Confirmed Genuine or Unresolved';
  END IF;
  IF s.reconciliation_result = 'System duplicate candidate' AND p_status NOT IN ('Confirmed Duplicate','Valid Separate Payment','Unresolved') THEN
    RAISE EXCEPTION 'Duplicate candidates may only be Confirmed Duplicate, Valid Separate Payment or Unresolved';
  END IF;
  IF p_status = 'Confirmed Duplicate' AND s.reconciliation_result <> 'System duplicate candidate' THEN
    RAISE EXCEPTION 'Only duplicate candidates can be marked Confirmed Duplicate';
  END IF;

  v_path := nullif(p_fields->>'attachment_path','');
  IF v_path IS NOT NULL THEN
    IF v_path !~ ('^' || p_collection_id::text || '/[A-Za-z0-9._-]+$') THEN RAISE EXCEPTION 'Evidence file must be in this collection''s own evidence folder'; END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'collection-evidence' AND so.name = v_path) THEN RAISE EXCEPTION 'Evidence file not found in the private evidence folder'; END IF;
  END IF;

  IF p_status IN ('Confirmed Genuine','Confirmed Duplicate','Confirmed Agent Mismatch','Valid Separate Payment') THEN
    IF nullif(p_fields->>'evidence_type','') IS NULL THEN RAISE EXCEPTION 'A confirmed status needs an evidence type'; END IF;
    IF nullif(trim(p_fields->>'evidence_reference'),'') IS NULL THEN RAISE EXCEPTION 'A confirmed status needs an evidence reference'; END IF;
    IF nullif(p_fields->>'evidence_date','') IS NULL THEN RAISE EXCEPTION 'A confirmed status needs an evidence date'; END IF;
    IF nullif(trim(p_fields->>'evidence_source'),'') IS NULL THEN RAISE EXCEPTION 'A confirmed status needs an evidence source'; END IF;
    IF nullif(trim(p_fields->>'notes'),'') IS NULL THEN RAISE EXCEPTION 'A confirmed status needs notes'; END IF;
  END IF;

  v_orig := nullif(p_fields->>'valid_original_id','')::uuid;
  v_agent := nullif(p_fields->>'confirmed_agent_id','')::uuid;
  IF p_status = 'Confirmed Duplicate' THEN
    IF v_orig IS NULL OR v_orig = p_collection_id THEN RAISE EXCEPTION 'Name the valid original collection (a different collection)'; END IF;
    IF nullif(p_fields->>'duplicate_collection_id','')::uuid IS DISTINCT FROM p_collection_id THEN RAISE EXCEPTION 'Identify this collection as the duplicate'; END IF;
    SELECT * INTO o FROM public.agent_collections WHERE id = v_orig;
    IF NOT FOUND THEN RAISE EXCEPTION 'Original collection not found'; END IF;
    IF o.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'The chosen original was reversed and is not a valid collection record'; END IF;
    IF o.agent_id IS DISTINCT FROM s.agent_id OR abs(extract(epoch FROM o.created_at - s.collected_at)) > 1800 THEN RAISE EXCEPTION 'The original must be one of the listed possible matches'; END IF;
    IF o.tenant_id IS DISTINCT FROM s.tenant_id OR o.rent_request_id IS DISTINCT FROM s.rent_plan_id OR o.amount <> s.amount THEN
      RAISE EXCEPTION 'The original must be the same tenant, Rent Plan and amount';
    END IF;
  ELSE v_orig := NULL; END IF;
  IF p_status = 'Confirmed Agent Mismatch' THEN
    IF v_agent IS NULL THEN RAISE EXCEPTION 'Name the confirmed collecting agent'; END IF;
    IF v_agent = s.agent_id THEN RAISE EXCEPTION 'Evidence shows the recorded agent collected — that is Confirmed Genuine, not a mismatch'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_agent) THEN RAISE EXCEPTION 'Confirmed agent not found'; END IF;
  ELSE v_agent := NULL; END IF;
  v_ready := CASE WHEN p_status IN ('Confirmed Duplicate','Confirmed Agent Mismatch') THEN 'Ready for CFO Review' ELSE 'Not Ready' END;

  UPDATE public.fin_collection_evidence_s12 SET
    evidence_status = p_status,
    evidence_type = nullif(p_fields->>'evidence_type',''),
    evidence_reference = nullif(trim(p_fields->>'evidence_reference'),''),
    receipt_number = nullif(p_fields->>'receipt_number',''),
    evidence_date = nullif(p_fields->>'evidence_date','')::date,
    evidence_source = nullif(trim(p_fields->>'evidence_source'),''),
    notes = nullif(trim(p_fields->>'notes'),''),
    attachment_path = coalesce(v_path, attachment_path),
    evidence_checklist = coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_fields->'evidence_checklist')='array' THEN p_fields->'evidence_checklist' ELSE '[]'::jsonb END) x WHERE x IN ('Agent receipt','Tenant confirmation','Cash handover evidence','Deposit evidence','Other supporting evidence')), '{}'),
    valid_original_id = v_orig, duplicate_of_id = CASE WHEN v_orig IS NULL THEN NULL ELSE p_collection_id END,
    confirmed_agent_id = v_agent, correction_status = v_ready,
    verified_by = auth.uid(), verified_at = now(), updated_at = now()
  WHERE collection_id = p_collection_id;

  INSERT INTO public.fin_collection_evidence_s12_audit (collection_id, actor, previous_status, new_status, reason, evidence_reference, notes, details)
  VALUES (p_collection_id, auth.uid(), v_prev, p_status, trim(p_reason), nullif(trim(p_fields->>'evidence_reference'),''), nullif(trim(p_fields->>'notes'),''), p_fields);
  PERFORM public.fin_s12_assert_controls();
  IF public.fin_s12_txn_financial_writes() <> v_fin THEN RAISE EXCEPTION 'Evidence save touched a financial record — refused and rolled back'; END IF;
END $function$;