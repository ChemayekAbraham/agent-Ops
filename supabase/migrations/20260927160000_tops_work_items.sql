-- Tenant Ops Workspace — our own work-item layer.
--
-- Per docs/TOPS_RULES.md: new, additive objects only. ops_inbox_state and
-- everything the existing inbox uses are untouched — confirmed by
-- inspection: nothing in this file references ops_inbox_state, and the
-- existing in-app public.notifications table is never written to (its
-- block_all_notification_inserts() trigger allows only 8 fixed types, none
-- of them ours — docs/TOPS_FINDINGS.md §8). tops_notifications is our own,
-- separate table for exactly that reason.
--
-- Notification channel, per docs/TOPS_FINDINGS.md §8: send-push-notification
-- (accepts {userIds, payload}, no type whitelist) is called UNCHANGED from
-- the frontend after a successful assign/escalate — that is the confirmed,
-- reusable-as-is existing function. The in-app, "render it in the tab" need
-- is the one FINDINGS says the existing mechanism cannot serve additively
-- (the 8-value type allowlist), so that part is tops_notifications, read by
-- our own tab only.

-- ---------------------------------------------------------------------------
-- 1. tops_work_items — read-only from the client. Every mutation goes
--    through a named function below; no direct INSERT/UPDATE/DELETE grant.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('critical', 'at_risk', 'watch', 'new')),
  reason text NOT NULL,
  value_at_risk_ugx numeric(14,2) NOT NULL,
  assigned_to uuid NULL,
  assigned_at timestamptz NULL,
  sla_due_at timestamptz NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  closed_outcome text NULL,
  closed_by uuid NULL,
  closed_at timestamptz NULL,
  escalated_to uuid NULL,
  escalated_at timestamptz NULL,
  escalation_note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tops_work_items_assigned_status_idx ON public.tops_work_items (assigned_to, status);
CREATE INDEX tops_work_items_bucket_value_idx ON public.tops_work_items (bucket, value_at_risk_ugx DESC);

COMMENT ON TABLE public.tops_work_items IS
'Our own work-item queue, ranked by value at risk from tops_plan_position. Read-only from the client — every mutation goes through tops_assign_work_item / tops_close_work_item / tops_escalate_work_item / tops_snooze_work_item / tops_refresh_work_items. Does not touch ops_inbox_state or anything the existing inbox uses.';

REVOKE ALL ON public.tops_work_items FROM PUBLIC;
GRANT SELECT ON public.tops_work_items TO authenticated;
ALTER TABLE public.tops_work_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_work_items_select_tops_roles ON public.tops_work_items
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- ---------------------------------------------------------------------------
-- 2. tops_notifications — our own in-app notification feed, rendered only
--    in our own tab. Insert-only via the mutation functions below; a client
--    may only mark their own notification read.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  work_item_id uuid NULL REFERENCES public.tops_work_items(id) ON DELETE CASCADE,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tops_notifications_user_read_idx ON public.tops_notifications (user_id, read_at);

COMMENT ON TABLE public.tops_notifications IS
'Our own in-app notification feed for the Tenant Ops Workspace tab — the existing public.notifications table cannot take a new type additively (its insert trigger allows only 8 fixed values, per docs/TOPS_FINDINGS.md §8), so this is a separate, parallel table, not a workaround on the existing one. Insert-only via tops_assign_work_item / tops_escalate_work_item; a user may only mark their own row read.';

REVOKE ALL ON public.tops_notifications FROM PUBLIC;
GRANT SELECT, UPDATE ON public.tops_notifications TO authenticated;
ALTER TABLE public.tops_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_notifications_select_own_or_ops ON public.tops_notifications
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE POLICY tops_notifications_update_own ON public.tops_notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. tops_refresh_work_items() — rebuilds OPEN items from tops_plan_position.
--
-- Bucket thresholds reuse the exact 1-7 / 8-14 / 15-30 / 30+ day-past-due
-- ladder tops_arrears_ageing already established, for one consistent mental
-- model across the workspace: new = 1-7, watch = 8-14, at_risk = 15-30,
-- critical = 30+ or an expired term (which always overrides to critical,
-- regardless of day count, since the whole outstanding balance is due now).
-- A plan with no unsettled due period at all (on track or ahead) gets no
-- item. SLA defaults (4h/24h/48h/72h by bucket) are this migration's own
-- policy choice — no SLA policy was specified elsewhere to reuse.
--
-- Idempotent by construction: an existing OPEN/IN_PROGRESS item for a plan
-- is only ever refreshed (bucket/reason/value_at_risk_ugx/updated_at) here,
-- never re-created; assigned_to, status, closed_*, escalated_* are never
-- touched by this function — those are exclusively human-owned fields,
-- changed only by the mutation functions below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_refresh_work_items()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rr record;
  v_pos record;
  v_bucket text;
  v_value_at_risk numeric(14,2);
  v_reason text;
  v_sla interval;
  v_existing_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_rr IN
    SELECT rr.id AS rent_request_id
    FROM public.rent_requests rr
    JOIN public.tops_plan_clock c ON c.rent_request_id = rr.id
    WHERE rr.status IN ('funded', 'repaying')
      AND c.cadence <> 'unknown'
  LOOP
    SELECT * INTO v_pos FROM public.tops_plan_position(v_rr.rent_request_id, NULL);
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF NOT (
      COALESCE(v_pos.days_past_due, 0) > 0
      OR (v_pos.term_expired IS TRUE AND COALESCE(v_pos.outstanding_ugx, 0) > 0)
    ) THEN
      CONTINUE;
    END IF;

    IF v_pos.term_expired IS TRUE THEN
      v_bucket := 'critical';
      v_value_at_risk := COALESCE(v_pos.outstanding_ugx, 0);
      v_reason := 'Term expired — ' || trim(to_char(COALESCE(v_pos.outstanding_ugx, 0), 'FM999,999,999')) || ' UGX due now, overdue regime applies';
      v_sla := interval '4 hours';
    ELSIF v_pos.days_past_due > 30 THEN
      v_bucket := 'critical';
      v_sla := interval '4 hours';
    ELSIF v_pos.days_past_due >= 15 THEN
      v_bucket := 'at_risk';
      v_sla := interval '24 hours';
    ELSIF v_pos.days_past_due >= 8 THEN
      v_bucket := 'watch';
      v_sla := interval '48 hours';
    ELSE
      v_bucket := 'new';
      v_sla := interval '72 hours';
    END IF;

    IF v_pos.term_expired IS NOT TRUE THEN
      v_value_at_risk := GREATEST(-COALESCE(v_pos.position_ugx, 0), 0);
      v_reason := v_pos.days_past_due || ' day' || CASE WHEN v_pos.days_past_due = 1 THEN '' ELSE 's' END
        || ' past due, ' || trim(to_char(v_value_at_risk, 'FM999,999,999')) || ' UGX behind';
    END IF;

    SELECT id INTO v_existing_id
    FROM public.tops_work_items
    WHERE rent_request_id = v_rr.rent_request_id AND status IN ('open', 'in_progress')
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE public.tops_work_items
      SET bucket = v_bucket, reason = v_reason, value_at_risk_ugx = v_value_at_risk, updated_at = now()
      WHERE id = v_existing_id;
    ELSE
      INSERT INTO public.tops_work_items (rent_request_id, bucket, reason, value_at_risk_ugx, sla_due_at)
      VALUES (v_rr.rent_request_id, v_bucket, v_reason, v_value_at_risk, now() + v_sla);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_refresh_work_items() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_refresh_work_items() IS
'Rebuilds OPEN tops_work_items from tops_plan_position, ranked by value at risk. Never duplicates an open item for a plan (updates the existing one instead), never touches assigned_to/status/closed_*/escalated_* on an existing item — those are human-owned. Internal engine only (no EXECUTE grant), driven by the tops-refresh-work-items-hourly cron job.';

SELECT cron.schedule(
  'tops-refresh-work-items-hourly',
  '0 * * * *',
  $$ SELECT public.tops_refresh_work_items(); $$
);

-- ---------------------------------------------------------------------------
-- 4. tops_assign_work_item / tops_close_work_item / tops_escalate_work_item /
--    tops_snooze_work_item — the only ways a client mutates tops_work_items.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_assign_work_item(p_work_item_id uuid, p_assigned_to uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_assigned_to IS NULL THEN
    RAISE EXCEPTION 'assigned_to is required';
  END IF;

  SELECT status INTO v_status FROM public.tops_work_items WHERE id = p_work_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found';
  END IF;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'cannot assign a closed work item';
  END IF;

  UPDATE public.tops_work_items
  SET assigned_to = p_assigned_to, assigned_at = now(), status = 'in_progress', updated_at = now()
  WHERE id = p_work_item_id;

  INSERT INTO public.tops_notifications (user_id, title, body, work_item_id)
  VALUES (p_assigned_to, 'Work item assigned to you', 'A tenant plan needs your attention.', p_work_item_id);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_assign_work_item(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_assign_work_item(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.tops_assign_work_item(uuid, uuid) IS
'Assigns a work item (moves status to in_progress) and writes a tops_notifications row for the assignee. Gated by an internal has_role check.';

CREATE OR REPLACE FUNCTION public.tops_close_work_item(p_work_item_id uuid, p_outcome text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_outcome IS NULL OR btrim(p_outcome) = '' THEN
    RAISE EXCEPTION 'outcome is required';
  END IF;

  UPDATE public.tops_work_items
  SET status = 'closed', closed_outcome = p_outcome, closed_by = auth.uid(), closed_at = now(), updated_at = now()
  WHERE id = p_work_item_id AND status <> 'closed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found or already closed';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_close_work_item(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_close_work_item(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.tops_close_work_item(uuid, text) IS
'Closes a work item. p_outcome is required and rejected if blank. Gated by an internal has_role check.';

CREATE OR REPLACE FUNCTION public.tops_escalate_work_item(p_work_item_id uuid, p_escalated_to uuid, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_escalated_to IS NULL THEN
    RAISE EXCEPTION 'escalated_to is required';
  END IF;

  UPDATE public.tops_work_items
  SET escalated_to = p_escalated_to, escalated_at = now(), escalation_note = p_note, updated_at = now()
  WHERE id = p_work_item_id AND status <> 'closed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found or already closed';
  END IF;

  INSERT INTO public.tops_notifications (user_id, title, body, work_item_id)
  VALUES (p_escalated_to, 'Work item escalated to you', COALESCE(p_note, 'A tenant plan was escalated to you.'), p_work_item_id);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_escalate_work_item(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_escalate_work_item(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.tops_escalate_work_item(uuid, uuid, text) IS
'Escalates a work item to a named person (escalated_to is required — an escalation names a person) and writes a tops_notifications row for them. Gated by an internal has_role check.';

-- Not one of the four named functions, but added for the brief's explicit
-- constraint: "a snooze here is visible to the whole team, not private to
-- one user." Writing to the one shared sla_due_at column everyone already
-- reads satisfies that by construction — there is no per-user snooze state
-- anywhere in this design.
CREATE OR REPLACE FUNCTION public.tops_snooze_work_item(p_work_item_id uuid, p_new_sla_due_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.tops_work_items
  SET sla_due_at = p_new_sla_due_at, updated_at = now()
  WHERE id = p_work_item_id AND status <> 'closed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found or already closed';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_snooze_work_item(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_snooze_work_item(uuid, timestamptz) TO authenticated;

COMMENT ON FUNCTION public.tops_snooze_work_item(uuid, timestamptz) IS
'Pushes sla_due_at forward on the one shared work item row — visible to the whole team, never a private/per-user snooze. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 5. tops_queue_latency(p_from, p_to)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_queue_latency(p_from date, p_to date)
RETURNS TABLE (
  median_time_to_first_action_hours numeric,
  median_time_to_close_hours numeric,
  sample_size_first_action integer,
  sample_size_closed integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (assigned_at - created_at)) / 3600.0)::numeric, 1)
     FROM public.tops_work_items
     WHERE created_at::date BETWEEN p_from AND p_to AND assigned_at IS NOT NULL),
    (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600.0)::numeric, 1)
     FROM public.tops_work_items
     WHERE created_at::date BETWEEN p_from AND p_to AND closed_at IS NOT NULL),
    (SELECT count(*)::integer FROM public.tops_work_items WHERE created_at::date BETWEEN p_from AND p_to AND assigned_at IS NOT NULL),
    (SELECT count(*)::integer FROM public.tops_work_items WHERE created_at::date BETWEEN p_from AND p_to AND closed_at IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_queue_latency(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_queue_latency(date, date) TO authenticated;

COMMENT ON FUNCTION public.tops_queue_latency(date, date) IS
'Median hours from work-item creation to first assignment, and to close, for items created in a date range. Gated by an internal has_role check.';
