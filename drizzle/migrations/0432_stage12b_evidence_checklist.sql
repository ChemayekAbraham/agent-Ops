-- Stage 12B: per-case evidence checklist (metadata only, no financial effect).
ALTER TABLE public.fin_collection_evidence_s12 ADD COLUMN IF NOT EXISTS evidence_checklist text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.cfo_s12_save_evidence(p_collection_id uuid, p_status text, p_reason text, p_fields jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_prev text; v_orig uuid; v_agent uuid; v_ready text; v_path text; v_n int; v_a numeric;
  s public.fin_collection_reconciliation_s11%ROWTYPE; o public.agent_collections%ROWTYPE;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT count(*), coalesce(sum(r.amount),0) INTO v_n, v_a FROM public.fin_collection_evidence_s12 e JOIN public.fin_collection_reconciliation_s11 r USING (collection_id);
  IF v_n <> 659 OR v_a <> 56946270 THEN RAISE EXCEPTION 'Stage 12 does not reconcile to 659 / UGX 56,946,270 — evidence decisions are locked'; END IF;
  IF p_status NOT IN ('Pending Evidence','Confirmed Genuine','Confirmed Duplicate','Confirmed Agent Mismatch','Valid Separate Payment','Unresolved') THEN RAISE EXCEPTION 'Unknown status'; END IF;
  IF length(coalesce(trim(p_reason),'')) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
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
END $function$;

REVOKE ALL ON FUNCTION public.cfo_s12_save_evidence(uuid,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s12_save_evidence(uuid,text,text,jsonb) TO authenticated;