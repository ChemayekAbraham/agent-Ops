CREATE OR REPLACE FUNCTION public.admin_unlink_subagent(_record_id uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_parent uuid;
  v_sub uuid;
  v_active int;
  v_links int := 0;
  v_cancelled int := 0;
  v_last uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
    OR public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'ceo')
    OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'agent_ops')
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: operations role required';
  END IF;

  IF coalesce(length(btrim(_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'REASON_TOO_SHORT: give at least 10 characters';
  END IF;

  SELECT parent_agent_id, sub_agent_id INTO v_parent, v_sub
  FROM public.agent_subagents WHERE id = _record_id;

  IF v_sub IS NULL THEN
    RAISE EXCEPTION 'LINK_NOT_FOUND';
  END IF;

  SELECT count(*) INTO v_active
  FROM public.rent_requests rr
  WHERE (rr.agent_id = v_sub OR rr.assigned_agent_id = v_sub)
    AND rr.status IN ('funded', 'repaying');

  IF v_active > 0 THEN
    RAISE EXCEPTION 'ACTIVE_TENANTS: transfer % active tenant(s) before unlinking', v_active;
  END IF;

  WITH cx AS (
    UPDATE public.subagent_tenant_transfers
       SET status = 'rejected',
           decided_by = v_actor,
           decided_at = now(),
           decision_reason = 'Auto-cancelled: sub-agent made independent by operations'
     WHERE parent_agent_id = v_parent
       AND status = 'pending'
       AND (from_sub_agent_id = v_sub OR to_sub_agent_id = v_sub)
    RETURNING 1
  )
  SELECT count(*) INTO v_cancelled FROM cx;

  UPDATE public.agent_listing_blocks
     SET active = false, unblocked_at = now(), unblocked_by = v_actor,
         unblock_reason = 'Operations made the sub-agent independent'
   WHERE agent_id = v_sub AND active
     AND blocked_by = v_parent
     AND COALESCE(auto_blocked, false) = false;

  WITH gone AS (
    DELETE FROM public.agent_subagents
     WHERE parent_agent_id = v_parent AND sub_agent_id = v_sub
    RETURNING id, parent_agent_id, sub_agent_id, source, status, created_at
  ), archived AS (
    INSERT INTO public.agent_subagent_link_archive (
      original_id, parent_agent_id, sub_agent_id, source, status,
      original_created_at, archive_reason, archived_by
    )
    SELECT g.id, g.parent_agent_id, g.sub_agent_id, g.source, g.status,
           g.created_at, btrim(_reason), v_actor
    FROM gone g
    RETURNING original_id
  )
  SELECT count(*), max(original_id) INTO v_links, v_last FROM archived;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  VALUES (
    'subagent_made_independent', 'agent_subagents', COALESCE(v_last, _record_id), v_actor, btrim(_reason),
    jsonb_build_object('parent_agent_id', v_parent, 'sub_agent_id', v_sub,
                       'links_removed', v_links, 'transfers_cancelled', v_cancelled,
                       'actor_kind', 'operations')
  );

  RETURN jsonb_build_object('success', true, 'unlinked_id', v_last,
                            'links_removed', v_links, 'transfers_cancelled', v_cancelled);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_unlink_subagent(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_unlink_subagent(uuid, text) TO authenticated;