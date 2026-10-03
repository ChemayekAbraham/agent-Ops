CREATE OR REPLACE FUNCTION public.fin_s12_txn_financial_writes()
 RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del),0)::bigint FROM pg_stat_xact_user_tables
  WHERE schemaname='public' AND relname IN ('general_ledger','wallets_physical','wallet_balances_projection','wallet_transactions',
   'agent_collections','rent_requests','agent_landlord_float','agent_landlord_float_allocations','agent_float_withdrawals',
   'agent_tenant_float_reversals','agent_commission_payouts','commission_accrual_ledger','deposit_requests','withdrawal_requests','landlord_payouts')
$f$;
CREATE OR REPLACE FUNCTION public.fin_s12_assert_controls()
 RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE n int; a numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount),0) INTO n, a FROM public.fin_collection_reconciliation_s11;
  IF n <> 659 OR a <> 56946270 THEN RAISE EXCEPTION 'Stage 11 control total changed (% / UGX %) — evidence save refused', n, a; END IF;
  SELECT count(*), coalesce(sum(amount),0) INTO n, a FROM public.fin_collection_reconciliation_s11 WHERE reconciliation_result='System-inconsistent';
  IF n <> 14 OR a <> 1684334 THEN RAISE EXCEPTION 'Agent-mismatch queue changed (% / UGX %) — evidence save refused', n, a; END IF;
  SELECT count(*) INTO n FROM public.fin_collection_reconciliation_s11 r JOIN public.agent_collections c ON c.id=r.collection_id
   WHERE c.amount=r.amount AND c.agent_id=r.agent_id AND c.reversed_at IS NOT DISTINCT FROM r.reversed_at AND c.rent_request_id IS NOT DISTINCT FROM r.rent_plan_id;
  IF n <> 659 THEN RAISE EXCEPTION 'Collections no longer match Stage 11 (% of 659) — evidence save refused', n; END IF;
END $f$;
REVOKE ALL ON FUNCTION public.fin_s12_txn_financial_writes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_s12_assert_controls() FROM PUBLIC, anon, authenticated;
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