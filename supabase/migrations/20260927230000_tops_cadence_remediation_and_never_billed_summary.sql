-- Tenant Ops Workspace — cadence remediation, and the never-billed
-- quarantine's own summary RPC. Per docs/TOPS_RULES.md: read-only lists,
-- and the one write action touches only tops_plan_clock (+ the existing,
-- unmodified tops_build_plan_instalments() to rebuild that plan's own
-- tops_plan_instalments) — never subscription_charges or any other existing
-- table.
--
-- No new table needed for the "who and when" requirement: tops_plan_clock
-- was already built (an earlier task) with set_by/override_reason columns
-- and a clock_source CHECK that already allows 'override' — clearly
-- provisioned for exactly this feature, never previously wired to an action.
-- tops_resolve_plan_clock() already skips any row where clock_source =
-- 'override' ("An override is a deliberate human correction; never
-- recompute over it") — so the action below reuses that EXACT existing
-- sentinel (not a new one) to guarantee a manual cadence fix cannot be
-- silently reverted by the next automatic resolve/catchup cron. Without
-- this, a plan whose repayment_frequency is still unlocked in rent_requests
-- would have its manually-set cadence recomputed straight back to
-- 'unknown' the next time tops_build_schedules_batch() touches it — a real
-- bug, caught by reading tops_resolve_plan_clock's actual existing body,
-- not assumed.

-- ---------------------------------------------------------------------------
-- 1. tops_unknown_cadence_plans(p_limit, p_offset) — the remediation queue.
--    Confirmed live: 515 of 820 active (funded/repaying) plans currently
--    show cadence = 'unknown' — a real, sizeable queue, not a handful — so
--    this is server-paginated like every other Collections-tab list, not a
--    small capped worklist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_unknown_cadence_plans(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_rows integer;
  v_rows jsonb;
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

  SELECT count(*) INTO v_total_rows
  FROM public.rent_requests rr
  JOIN public.tops_plan_clock c ON c.rent_request_id = rr.id
  WHERE rr.status IN ('funded', 'repaying') AND c.cadence = 'unknown';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rent_request_id', x.rent_request_id,
    'tenant_name', tp.full_name,
    'agent_name', ap.full_name,
    'repayment_frequency', x.repayment_frequency,
    'repayment_frequency_locked', x.repayment_frequency_locked,
    'total_repayment_ugx', x.total_repayment,
    'created_at', x.created_at
  ) ORDER BY x.created_at ASC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT rr.id AS rent_request_id, rr.tenant_id, rr.assigned_agent_id, rr.agent_id,
      rr.repayment_frequency, rr.repayment_frequency_locked, rr.total_repayment, rr.created_at
    FROM public.rent_requests rr
    JOIN public.tops_plan_clock c ON c.rent_request_id = rr.id
    WHERE rr.status IN ('funded', 'repaying') AND c.cadence = 'unknown'
    ORDER BY rr.created_at ASC
    LIMIT p_limit OFFSET p_offset
  ) x
  LEFT JOIN public.profiles tp ON tp.id = x.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(x.assigned_agent_id, x.agent_id);

  RETURN jsonb_build_object('total_row_count', v_total_rows, 'rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_unknown_cadence_plans(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_unknown_cadence_plans(integer, integer) TO authenticated;

COMMENT ON FUNCTION public.tops_unknown_cadence_plans(integer, integer) IS
'Server-paginated list of active (funded/repaying) plans whose tops_plan_clock.cadence is unknown — the remediation queue tops_set_plan_cadence() shrinks. repayment_frequency/repayment_frequency_locked are surfaced as read-only context for whoever is picking the right cadence, never used to auto-decide it. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 2. tops_set_plan_cadence(p_rent_request_id, p_cadence, p_reason) — the
--    remediation action. Writes ONLY to tops_plan_clock, then calls the
--    EXISTING, unmodified tops_build_plan_instalments() to rebuild that
--    plan's instalments for the newly-set cadence. Never touches
--    subscription_charges or any other existing table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_set_plan_cadence(p_rent_request_id uuid, p_cadence text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clock_start date;
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

  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'cadence must be daily or weekly, got %', p_cadence;
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required to manually set a plan''s cadence';
  END IF;

  SELECT clock_start INTO v_clock_start FROM public.tops_plan_clock WHERE rent_request_id = p_rent_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no tops_plan_clock row exists for this plan';
  END IF;

  UPDATE public.tops_plan_clock
  SET
    cadence = p_cadence,
    cadence_source = 'explicit',
    -- Same sentinel tops_resolve_plan_clock() already checks for and skips
    -- ("An override is a deliberate human correction; never recompute over
    -- it") — reused, not invented, so a still-unlocked repayment_frequency
    -- can never silently revert this fix on the next automatic resolve.
    clock_source = 'override',
    weekly_due_dow = CASE WHEN p_cadence = 'weekly' THEN EXTRACT(DOW FROM v_clock_start)::smallint ELSE NULL END,
    override_reason = p_reason,
    set_by = auth.uid(),
    updated_at = now()
  WHERE rent_request_id = p_rent_request_id;

  PERFORM public.tops_build_plan_instalments(p_rent_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_set_plan_cadence(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_set_plan_cadence(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.tops_set_plan_cadence(uuid, text, text) IS
'Manually sets a plan''s cadence (daily/weekly only) when tops_plan_clock.cadence was unknown, records who (set_by=auth.uid()) and when (updated_at) plus a required reason (override_reason), sets clock_source=''override'' so tops_resolve_plan_clock() never reverts it, and rebuilds that plan''s tops_plan_instalments via the existing tops_build_plan_instalments(). Writes to tops_plan_clock only — never subscription_charges or any other existing table. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 3. tops_never_billed_summary(p_as_at) — a standalone count+total for the
--    never-billed quarantine, using the exact same basis
--    tops_never_billed()'s own embedded summary already uses
--    (tops_open_instalments_asof().never_billed), so a header/badge can read
--    just the summary without paginating the full row list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_never_billed_summary(p_as_at date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_count integer;
  v_total_ugx numeric;
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

  SELECT count(DISTINCT o.rent_request_id), COALESCE(SUM(o.outstanding_ugx), 0)
  INTO v_count, v_total_ugx
  FROM public.tops_open_instalments_asof(v_as_at) o
  WHERE o.never_billed;

  RETURN jsonb_build_object(
    'as_at', v_as_at,
    'count', v_count,
    'arrears_ugx', v_total_ugx,
    'basis', 'kampala;reversals_excluded;never_billed_quarantine'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_never_billed_summary(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_never_billed_summary(date) TO authenticated;

COMMENT ON FUNCTION public.tops_never_billed_summary(date) IS
'Standalone count + total UGX of never-billed arrears (tops_open_instalments_asof().never_billed — a due date that never appeared in agent_expected_day_plans), same basis tops_never_billed() already embeds in its own paginated response. Exists so a header/badge can read just the summary without also fetching/paginating the row list. Confirmed live: due-today/arrears-ageing/movement/the collection scoreboard already exclude never-billed instalments from every arrears total by construction (due-today reads agent_expected_day_plans directly, which never-billed days are absent from by definition) or by explicit filter (arrears-ageing, movement) — verified by inspection, nothing changed. Gated by an internal has_role check.';
