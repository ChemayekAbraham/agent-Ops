-- Stage 12: evidence files must sit in the private bucket, inside the owning collection's folder, and exist. No financial effect.
CREATE OR REPLACE FUNCTION public.cfo_s12_save_evidence(p_collection_id uuid, p_status text, p_reason text, p_fields jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_prev text; v_orig uuid; v_agent uuid; v_ready text; v_path text;
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF length(coalesce(trim(p_reason),'')) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  SELECT evidence_status INTO v_prev FROM public.fin_collection_evidence_s12 WHERE collection_id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Collection is not in the Stage 11 population'; END IF;
  v_path := nullif(p_fields->>'attachment_path','');
  IF v_path IS NOT NULL THEN
    IF v_path !~ ('^' || p_collection_id::text || '/[A-Za-z0-9._-]+$') THEN
      RAISE EXCEPTION 'Evidence file must be in this collection''s own evidence folder';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'collection-evidence' AND o.name = v_path) THEN
      RAISE EXCEPTION 'Evidence file not found in the private evidence folder';
    END IF;
  END IF;
  v_orig := nullif(p_fields->>'valid_original_id','')::uuid;
  v_agent := nullif(p_fields->>'confirmed_agent_id','')::uuid;
  IF p_status IN ('Confirmed Genuine','Confirmed Duplicate','Confirmed Agent Mismatch','Valid Separate Payment')
     AND nullif(p_fields->>'evidence_type','') IS NULL THEN
    RAISE EXCEPTION 'A confirmed status needs an evidence type';
  END IF;
  IF p_status = 'Confirmed Duplicate' THEN
    IF v_orig IS NULL OR v_orig = p_collection_id THEN RAISE EXCEPTION 'Name the valid original collection (a different collection)'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.agent_collections WHERE id = v_orig) THEN RAISE EXCEPTION 'Original collection not found'; END IF;
  ELSE v_orig := NULL; END IF;
  IF p_status = 'Confirmed Agent Mismatch' THEN
    IF v_agent IS NULL THEN RAISE EXCEPTION 'Name the confirmed collecting agent'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_agent) THEN RAISE EXCEPTION 'Confirmed agent not found'; END IF;
  ELSE v_agent := NULL; END IF;
  v_ready := CASE WHEN p_status IN ('Confirmed Duplicate','Confirmed Agent Mismatch') THEN 'Ready for CFO Review' ELSE 'Not Ready' END;

  UPDATE public.fin_collection_evidence_s12 SET
    evidence_status = p_status,
    evidence_type = nullif(p_fields->>'evidence_type',''),
    evidence_reference = nullif(p_fields->>'evidence_reference',''),
    receipt_number = nullif(p_fields->>'receipt_number',''),
    evidence_date = nullif(p_fields->>'evidence_date','')::date,
    evidence_source = nullif(p_fields->>'evidence_source',''),
    notes = nullif(p_fields->>'notes',''),
    attachment_path = coalesce(v_path, attachment_path),
    valid_original_id = v_orig, duplicate_of_id = CASE WHEN v_orig IS NULL THEN NULL ELSE p_collection_id END,
    confirmed_agent_id = v_agent, correction_status = v_ready,
    verified_by = auth.uid(), verified_at = now(), updated_at = now()
  WHERE collection_id = p_collection_id;

  INSERT INTO public.fin_collection_evidence_s12_audit (collection_id, actor, previous_status, new_status, reason, evidence_reference, notes, details)
  VALUES (p_collection_id, auth.uid(), v_prev, p_status, trim(p_reason), nullif(p_fields->>'evidence_reference',''), nullif(p_fields->>'notes',''), p_fields);
END $function$;

REVOKE ALL ON FUNCTION public.cfo_s12_save_evidence(uuid,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_s12_save_evidence(uuid,text,text,jsonb) TO authenticated;