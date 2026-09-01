CREATE OR REPLACE FUNCTION public.retire_tenant_document(p_doc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.tenant_documents%ROWTYPE;
  v_allowed boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_row FROM public.tenant_documents WHERE id = p_doc_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'document not found';
  END IF;

  v_allowed := (v_row.uploaded_by = v_uid)
            OR public.can_manage_tenant_documents(v_uid)
            OR EXISTS (
                 SELECT 1 FROM public.rent_requests rr
                 WHERE rr.tenant_id = v_row.tenant_id
                   AND (rr.agent_id = v_uid OR rr.assigned_agent_id = v_uid)
               );

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'not authorised to change this tenant document';
  END IF;

  UPDATE public.tenant_documents
     SET is_current = false
   WHERE id = p_doc_id;

  RETURN jsonb_build_object('success', true, 'document_id', p_doc_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.retire_tenant_document(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.retire_tenant_document(uuid) TO authenticated;