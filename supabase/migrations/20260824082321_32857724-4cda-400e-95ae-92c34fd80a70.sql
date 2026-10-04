CREATE OR REPLACE FUNCTION public.partner_ops_bulk_delete_proxy_agents(p_agent_ids uuid[], p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),'');
  v_ids uuid[];
  v_identities int := 0;
  v_notes int := 0;
  v_assignments int := 0;
  v_invites int := 0;
  v_id uuid;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'partner_ops'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Provide a reason of at least 10 characters';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids
    FROM unnest(COALESCE(p_agent_ids, '{}'::uuid[])) AS x
   WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RAISE EXCEPTION 'Select at least one proxy agent';
  END IF;

  DELETE FROM public.promissory_notes WHERE agent_id = ANY(v_ids);
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  UPDATE public.proxy_agent_assignments
     SET is_active = false, updated_at = now()
   WHERE agent_id = ANY(v_ids) AND is_active;
  GET DIAGNOSTICS v_assignments = ROW_COUNT;

  DELETE FROM public.proxy_partner_invites WHERE proxy_agent_id = ANY(v_ids);
  GET DIAGNOSTICS v_invites = ROW_COUNT;

  DELETE FROM public.proxy_agent_identity WHERE agent_user_id = ANY(v_ids);
  GET DIAGNOSTICS v_identities = ROW_COUNT;

  FOREACH v_id IN ARRAY v_ids LOOP
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'proxy_agent_deleted', 'proxy_agent_identity', v_id::text, v_reason,
            jsonb_build_object('bulk', true, 'batch_size', array_length(v_ids,1)));
  END LOOP;

  RETURN jsonb_build_object(
    'agents_deleted', v_identities,
    'notes_deleted', v_notes,
    'assignments_deactivated', v_assignments,
    'invites_deleted', v_invites
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_ops_bulk_delete_proxy_agents(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_bulk_delete_proxy_agents(uuid[], text) TO authenticated;