-- 1) Transfer request: ownership via agent_id OR assigned_agent_id, active-plan gate,
--    suspended-recipient gate, one-pending-per-tenant gate.
CREATE OR REPLACE FUNCTION public.agent_request_subagent_tenant_transfer(p_rent_request_id uuid, p_to_sub_agent_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid := auth.uid();
  v_from uuid;
  v_tenant uuid;
  v_status text;
  v_id uuid;
BEGIN
  IF v_parent IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT r.tenant_id, r.status,
         CASE
           WHEN EXISTS (SELECT 1 FROM public.agent_subagents s
                        WHERE s.parent_agent_id = v_parent AND s.sub_agent_id = r.agent_id AND s.status = 'verified')
             THEN r.agent_id
           WHEN EXISTS (SELECT 1 FROM public.agent_subagents s
                        WHERE s.parent_agent_id = v_parent AND s.sub_agent_id = r.assigned_agent_id AND s.status = 'verified')
             THEN r.assigned_agent_id
           ELSE NULL
         END
    INTO v_tenant, v_status, v_from
  FROM public.rent_requests r
  WHERE r.id = p_rent_request_id;

  IF v_status IS NULL THEN RAISE EXCEPTION 'Rent plan not found'; END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'That tenant does not belong to one of your sub-agents';
  END IF;
  IF v_status NOT IN ('funded','repaying') THEN
    RAISE EXCEPTION 'Only funded or repaying rent plans can be transferred (this plan is %)', v_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = p_to_sub_agent_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'The receiving sub-agent is not linked to your account';
  END IF;

  IF v_from = p_to_sub_agent_id THEN
    RAISE EXCEPTION 'The tenant already belongs to this sub-agent';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_listing_blocks b
    WHERE b.agent_id = p_to_sub_agent_id AND b.active
      AND (b.blocked_until IS NULL OR b.blocked_until > now())
  ) THEN
    RAISE EXCEPTION 'The receiving sub-agent is suspended. Restore them before moving tenants to them';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subagent_tenant_transfers
    WHERE status = 'pending'
      AND (rent_request_id = p_rent_request_id
           OR (v_tenant IS NOT NULL AND tenant_id = v_tenant))
  ) THEN
    RAISE EXCEPTION 'A transfer request for this tenant is already awaiting approval';
  END IF;

  INSERT INTO public.subagent_tenant_transfers
    (parent_agent_id, rent_request_id, tenant_id, from_sub_agent_id, to_sub_agent_id, reason)
  VALUES (v_parent, p_rent_request_id, v_tenant, v_from, p_to_sub_agent_id, btrim(p_reason))
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_parent, 'subagent_tenant_transfer_requested', 'subagent_tenant_transfers', v_id, btrim(p_reason),
          jsonb_build_object('rent_request_id', p_rent_request_id, 'from', v_from, 'to', p_to_sub_agent_id,
                             'plan_status', v_status));

  RETURN jsonb_build_object('success', true, 'transfer_id', v_id, 'status', 'pending');
END;
$function$;

-- 2) Suspend: never cancel company/automatic freezes; only supersede this parent's own freeze.
CREATE OR REPLACE FUNCTION public.agent_suspend_subagent(p_sub_agent_id uuid, p_days integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid := auth.uid();
  v_until timestamptz;
BEGIN
  IF v_parent IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'Suspension period must be between 1 and 90 days';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = p_sub_agent_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'This sub-agent is not linked to your account';
  END IF;

  v_until := now() + make_interval(days => p_days);

  -- Only this parent's own manual freeze is superseded. Company / automatic
  -- freezes (fraud, ops) are left untouched.
  UPDATE public.agent_listing_blocks
     SET active = false, unblocked_at = now(), unblocked_by = v_parent,
         unblock_reason = 'Superseded by parent agent suspension'
   WHERE agent_id = p_sub_agent_id AND active
     AND blocked_by = v_parent
     AND COALESCE(auto_blocked, false) = false;

  INSERT INTO public.agent_listing_blocks (agent_id, blocked_until, reason, auto_blocked, active, blocked_by, freeze_scope)
  VALUES (p_sub_agent_id, v_until, btrim(p_reason), false, true, v_parent, 'all');

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_parent, 'subagent_suspended', 'agent_listing_blocks', p_sub_agent_id, btrim(p_reason),
          jsonb_build_object('days', p_days, 'until', v_until, 'parent_agent_id', v_parent));

  RETURN jsonb_build_object('success', true, 'blocked_until', v_until);
END;
$function$;

-- 3) Restore: only lift this parent's own manual freeze (explicit, auditable).
CREATE OR REPLACE FUNCTION public.agent_restore_subagent(p_sub_agent_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid := auth.uid();
  v_lifted int := 0;
BEGIN
  IF v_parent IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = p_sub_agent_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'This sub-agent is not linked to your account';
  END IF;

  WITH lifted AS (
    UPDATE public.agent_listing_blocks
       SET active = false, unblocked_at = now(), unblocked_by = v_parent, unblock_reason = btrim(p_reason)
     WHERE agent_id = p_sub_agent_id AND active
       AND blocked_by = v_parent
       AND COALESCE(auto_blocked, false) = false
    RETURNING 1
  )
  SELECT count(*) INTO v_lifted FROM lifted;

  IF v_lifted = 0 THEN
    RAISE EXCEPTION 'You have no active suspension on this sub-agent to lift';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_parent, 'subagent_restored', 'agent_listing_blocks', p_sub_agent_id, btrim(p_reason),
          jsonb_build_object('parent_agent_id', v_parent, 'blocks_lifted', v_lifted));

  RETURN jsonb_build_object('success', true, 'blocks_lifted', v_lifted);
END;
$function$;

-- 4) Unlink: assigned-agent aware active check, archive+delete every duplicate link row,
--    cancel this parent's pending transfers for the sub-agent, lift the parent's suspension.
CREATE OR REPLACE FUNCTION public.agent_unlink_subagent(p_sub_agent_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid := auth.uid();
  v_active int;
  v_links int;
  v_cancelled int := 0;
  v_last uuid;
BEGIN
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF coalesce(length(btrim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'REASON_TOO_SHORT: give at least 10 characters';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = p_sub_agent_id
  ) THEN
    RAISE EXCEPTION 'LINK_NOT_FOUND';
  END IF;

  SELECT count(*) INTO v_active
  FROM public.rent_requests rr
  WHERE (rr.agent_id = p_sub_agent_id OR rr.assigned_agent_id = p_sub_agent_id)
    AND rr.status IN ('funded', 'repaying');

  IF v_active > 0 THEN
    RAISE EXCEPTION 'ACTIVE_TENANTS: transfer % active tenant(s) before unlinking', v_active;
  END IF;

  -- Cancel this parent's pending transfers touching the sub-agent so Agent Ops
  -- can never approve a move into or out of an unlinked account.
  WITH cx AS (
    UPDATE public.subagent_tenant_transfers
       SET status = 'rejected',
           decided_by = v_parent,
           decided_at = now(),
           decision_reason = 'Auto-cancelled: sub-agent unlinked from the parent agent'
     WHERE parent_agent_id = v_parent
       AND status = 'pending'
       AND (from_sub_agent_id = p_sub_agent_id OR to_sub_agent_id = p_sub_agent_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_cancelled FROM cx;

  -- Lift any suspension this parent placed: an ex-parent must not keep them frozen.
  UPDATE public.agent_listing_blocks
     SET active = false, unblocked_at = now(), unblocked_by = v_parent,
         unblock_reason = 'Parent agent unlinked the sub-agent'
   WHERE agent_id = p_sub_agent_id AND active
     AND blocked_by = v_parent
     AND COALESCE(auto_blocked, false) = false;

  -- Archive and remove EVERY link row for this pair (duplicates included).
  WITH gone AS (
    DELETE FROM public.agent_subagents
     WHERE parent_agent_id = v_parent AND sub_agent_id = p_sub_agent_id
    RETURNING id, parent_agent_id, sub_agent_id, source, status, created_at
  ), archived AS (
    INSERT INTO public.agent_subagent_link_archive (
      original_id, parent_agent_id, sub_agent_id, source, status,
      original_created_at, archive_reason, archived_by
    )
    SELECT g.id, g.parent_agent_id, g.sub_agent_id, g.source, g.status,
           g.created_at, btrim(p_reason), v_parent
    FROM gone g
    RETURNING original_id
  )
  SELECT count(*), max(original_id) INTO v_links, v_last FROM archived;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  VALUES (
    'subagent_unlinked', 'agent_subagents', v_last, v_parent, btrim(p_reason),
    jsonb_build_object('parent_agent_id', v_parent, 'sub_agent_id', p_sub_agent_id,
                       'links_removed', v_links, 'transfers_cancelled', v_cancelled)
  );

  RETURN jsonb_build_object('success', true, 'unlinked_id', v_last,
                            'links_removed', v_links, 'transfers_cancelled', v_cancelled);
END;
$function$;

-- 5) Ops decision: re-validate link + plan at approval time; close duplicates for the same plan.
CREATE OR REPLACE FUNCTION public.ops_decide_subagent_tenant_transfer(p_transfer_id uuid, p_approve boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.subagent_tenant_transfers;
  v_tasks int := 0;
  v_plan_status text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.is_ops_role(v_actor) OR public.has_role(v_actor,'agent_ops') OR public.has_role(v_actor,'super_admin')) THEN
    RAISE EXCEPTION 'Only agent operations can decide tenant transfers';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A decision reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_row FROM public.subagent_tenant_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Transfer request not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This request was already decided'; END IF;

  IF p_approve THEN
    SELECT status INTO v_plan_status FROM public.rent_requests
     WHERE id = v_row.rent_request_id FOR UPDATE;
    IF v_plan_status IS NULL THEN
      RAISE EXCEPTION 'The rent plan no longer exists';
    END IF;
    IF v_plan_status NOT IN ('funded','repaying') THEN
      RAISE EXCEPTION 'The rent plan is no longer active (%). Reject this request instead', v_plan_status;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.agent_subagents
      WHERE parent_agent_id = v_row.parent_agent_id
        AND sub_agent_id = v_row.to_sub_agent_id
        AND status = 'verified'
    ) THEN
      RAISE EXCEPTION 'The receiving sub-agent is no longer linked to the requesting agent';
    END IF;

    UPDATE public.rent_requests
       SET agent_id = v_row.to_sub_agent_id,
           assigned_agent_id = v_row.to_sub_agent_id,
           updated_at = now()
     WHERE id = v_row.rent_request_id;

    -- Open work follows the tenant. Historical collections stay with whoever
    -- collected them (commission integrity) but are reachable through the plan.
    UPDATE public.agent_tasks
       SET agent_id = v_row.to_sub_agent_id,
           updated_at = now()
     WHERE agent_id = v_row.from_sub_agent_id
       AND tenant_id = v_row.tenant_id
       AND COALESCE(status,'pending') NOT IN ('completed','cancelled');
    v_tasks := COALESCE((SELECT count(*) FROM public.agent_tasks
       WHERE agent_id = v_row.to_sub_agent_id AND tenant_id = v_row.tenant_id), 0);
  END IF;

  UPDATE public.subagent_tenant_transfers
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decided_by = v_actor,
         decided_at = now(),
         decision_reason = btrim(p_reason)
   WHERE id = p_transfer_id;

  -- Any other pending request for the same plan is now stale.
  UPDATE public.subagent_tenant_transfers
     SET status = 'rejected', decided_by = v_actor, decided_at = now(),
         decision_reason = 'Auto-cancelled: superseded by another decision on the same rent plan'
   WHERE rent_request_id = v_row.rent_request_id
     AND id <> p_transfer_id
     AND status = 'pending';

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, CASE WHEN p_approve THEN 'subagent_tenant_transfer_approved' ELSE 'subagent_tenant_transfer_rejected' END,
          'subagent_tenant_transfers', p_transfer_id, btrim(p_reason),
          jsonb_build_object('rent_request_id', v_row.rent_request_id, 'from', v_row.from_sub_agent_id,
                             'to', v_row.to_sub_agent_id, 'tasks_moved', v_tasks));

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('role_changed', v_actor, 'rent_request', v_row.rent_request_id,
          jsonb_build_object(
            'action', CASE WHEN p_approve THEN 'tenant_transfer_approved' ELSE 'tenant_transfer_rejected' END,
            'from_agent_id', v_row.from_sub_agent_id,
            'to_agent_id', v_row.to_sub_agent_id,
            'tenant_id', v_row.tenant_id,
            'reason', btrim(p_reason)));

  RETURN jsonb_build_object('success', true, 'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END;
$function$;