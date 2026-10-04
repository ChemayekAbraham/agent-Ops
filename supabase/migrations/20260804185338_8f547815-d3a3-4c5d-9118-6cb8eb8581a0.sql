CREATE OR REPLACE FUNCTION public.agent_unlink_subagent(
  p_sub_agent_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent uuid := auth.uid();
  v_link public.agent_subagents;
  v_active int;
BEGIN
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF coalesce(length(btrim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'REASON_TOO_SHORT: give at least 10 characters';
  END IF;

  SELECT * INTO v_link
  FROM public.agent_subagents
  WHERE parent_agent_id = v_parent
    AND sub_agent_id = p_sub_agent_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_link.id IS NULL THEN
    RAISE EXCEPTION 'LINK_NOT_FOUND';
  END IF;

  SELECT count(*) INTO v_active
  FROM public.rent_requests rr
  WHERE rr.agent_id = p_sub_agent_id
    AND rr.status IN ('funded', 'repaying');

  IF v_active > 0 THEN
    RAISE EXCEPTION 'ACTIVE_TENANTS: transfer % active tenant(s) before unlinking', v_active;
  END IF;

  INSERT INTO public.agent_subagent_link_archive (
    original_id, parent_agent_id, sub_agent_id, source, status,
    original_created_at, archive_reason, archived_by
  ) VALUES (
    v_link.id, v_link.parent_agent_id, v_link.sub_agent_id, v_link.source, v_link.status,
    v_link.created_at, btrim(p_reason), v_parent
  );

  DELETE FROM public.agent_subagents WHERE id = v_link.id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  VALUES (
    'subagent_unlinked', 'agent_subagents', v_link.id, v_parent, btrim(p_reason),
    jsonb_build_object('parent_agent_id', v_parent, 'sub_agent_id', p_sub_agent_id, 'source', v_link.source)
  );

  RETURN jsonb_build_object('success', true, 'unlinked_id', v_link.id);
END;
$$;

REVOKE ALL ON FUNCTION public.agent_unlink_subagent(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_unlink_subagent(uuid, text) TO authenticated;