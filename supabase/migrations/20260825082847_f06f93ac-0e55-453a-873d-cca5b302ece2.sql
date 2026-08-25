CREATE OR REPLACE FUNCTION public.bulk_delete_promissory_notes(p_note_ids uuid[], p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ids uuid[];
  v_blocked jsonb := '[]'::jsonb;
  v_deletable uuid[];
  v_deleted int := 0;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Not authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_actor
      AND ur.role = ANY (ARRAY['operations','partner_ops','cfo','coo','manager','ceo','super_admin']::app_role[])
  ) THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Not authorized to delete promissory notes');
  END IF;

  IF char_length(v_reason) < 10 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'A reason of at least 10 characters is required');
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids
  FROM unnest(coalesce(p_note_ids, ARRAY[]::uuid[])) AS t(x)
  WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'No notes selected');
  END IF;

  IF array_length(v_ids, 1) > 200 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Select at most 200 notes per batch');
  END IF;

  -- Financially linked notes are never deleted; they are reported back.
  WITH candidates AS (
    SELECT n.id, n.partner_name
    FROM public.promissory_notes n
    WHERE n.id = ANY (v_ids)
  ), blocked AS (
    SELECT c.id, c.partner_name,
      CASE
        WHEN EXISTS (SELECT 1 FROM public.partner_self_commitments s WHERE s.promissory_note_id = c.id)
          THEN 'Linked to a partner self-support commitment'
        ELSE 'Linked to a pending partner portfolio'
      END AS reason
    FROM candidates c
    WHERE EXISTS (SELECT 1 FROM public.partner_self_commitments s WHERE s.promissory_note_id = c.id)
       OR EXISTS (SELECT 1 FROM public.funder_pending_portfolios f WHERE f.promissory_note_id = c.id)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'partner_name', b.partner_name, 'reason', b.reason)), '[]'::jsonb)
  INTO v_blocked
  FROM blocked b;

  SELECT array_agg(n.id) INTO v_deletable
  FROM public.promissory_notes n
  WHERE n.id = ANY (v_ids)
    AND NOT EXISTS (SELECT 1 FROM public.partner_self_commitments s WHERE s.promissory_note_id = n.id)
    AND NOT EXISTS (SELECT 1 FROM public.funder_pending_portfolios f WHERE f.promissory_note_id = n.id);

  IF v_deletable IS NULL OR array_length(v_deletable, 1) = 0 THEN
    RETURN jsonb_build_object('status', 'ok', 'deleted', 0, 'blocked', v_blocked);
  END IF;

  -- Audit trail BEFORE removal (one set-based insert, no N+1)
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  SELECT v_actor, 'delete', 'bulk_delete_promissory_note', 'promissory_notes', n.id::text,
    jsonb_build_object(
      'reason', v_reason,
      'partner_name', n.partner_name,
      'whatsapp_number', n.whatsapp_number,
      'amount', n.amount,
      'total_collected', n.total_collected,
      'status', n.status,
      'approval_bonus_paid', n.approval_bonus_paid,
      'agent_id', n.agent_id,
      'batch_size', array_length(v_deletable, 1),
      'deleted_at', now()
    )
  FROM public.promissory_notes n
  WHERE n.id = ANY (v_deletable);

  -- Cascade cleanup of dependent rows so the agent side keeps no orphans
  DELETE FROM public.promissory_note_release_notices WHERE note_id = ANY (v_deletable);
  DELETE FROM public.promissory_note_pledge_notices WHERE note_id = ANY (v_deletable);
  DELETE FROM public.promissory_note_plan_intents WHERE note_id = ANY (v_deletable);
  DELETE FROM public.partner_note_overrides WHERE note_id = ANY (v_deletable);
  DELETE FROM public.partner_note_reversals WHERE note_id = ANY (v_deletable);

  -- Commission history is retained but unlinked (nullable reference)
  UPDATE public.promissory_commission_events SET note_id = NULL WHERE note_id = ANY (v_deletable);

  DELETE FROM public.promissory_notes WHERE id = ANY (v_deletable);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('status', 'ok', 'deleted', v_deleted, 'blocked', v_blocked);
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_delete_promissory_notes(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_delete_promissory_notes(uuid[], text) TO authenticated;