-- Tenant Ops Workspace — pagination/sort hardening pass. Per the brief: every
-- list must be server-paginated and server-sorted; fix any that pull a page
-- and sort/filter/paginate in the browser. Every object touched here is one
-- of OUR OWN existing tops_ functions (never a Classic or cc_* object), and
-- every change is either a pure ORDER BY addition or new trailing DEFAULT
-- parameters — CREATE OR REPLACE preserves the existing EXECUTE grant in
-- both cases, so no REVOKE/GRANT needs re-stating for the four functions
-- amended below. The three brand-new companion count functions get the full
-- REVOKE ALL FROM PUBLIC, anon / GRANT TO authenticated treatment as usual.
--
-- What is deliberately NOT touched here: useCallingQueue.ts's in-page
-- re-sort of cc_call_queue_page's results. That RPC belongs to the calling
-- engine (docs/TOPS_RULES.md rule 7 — never touch cc_*), so it cannot be
-- taught to sort by OUR bucket/money-at-risk concepts, which it has no way
-- to know about. The re-sort there is confined to the single page (<=50
-- rows) the engine already selected and paginated server-side — it never
-- re-paginates or re-selects what belongs on that page — and is recorded as
-- a deliberate, retained exception in docs/TOPS_BUILD_LOG.md rather than
-- worked around by rebuilding the calling engine's own queue selection.

-- ---------------------------------------------------------------------------
-- 1. tops_agent_arrears_book — add a server-side ORDER BY so the frontend no
--    longer needs to aggregate-then-sort in JS. Same signature, same return
--    shape (one row per agent x bucket); ordered so a given agent's four
--    bucket rows are contiguous and ordered by that agent's total arrears
--    (summed across all of their buckets) descending — exactly the ordering
--    useAgentArrearsBook.ts's own useMemo used to compute by hand.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_arrears_book(p_as_at date DEFAULT NULL::date)
RETURNS TABLE(agent_id uuid, agent_name text, bucket text, plan_count integer, arrears_ugx numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
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
  WITH plans AS (
    SELECT
      o.rent_request_id,
      SUM(o.outstanding_ugx) AS arrears_ugx,
      MIN(o.due_date) AS oldest_due_date
    FROM public.tops_open_instalments_asof(v_as_at) o
    WHERE NOT o.never_billed
    GROUP BY o.rent_request_id
  ),
  bucketed AS (
    SELECT
      COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
      p.arrears_ugx,
      CASE
        WHEN (v_as_at - p.oldest_due_date) BETWEEN 1 AND 7 THEN '1-7'
        WHEN (v_as_at - p.oldest_due_date) BETWEEN 8 AND 14 THEN '8-14'
        WHEN (v_as_at - p.oldest_due_date) BETWEEN 15 AND 30 THEN '15-30'
        ELSE '30+'
      END AS bucket
    FROM plans p
    JOIN public.rent_requests rr ON rr.id = p.rent_request_id
  ),
  book AS (
    SELECT
      b.agent_id,
      ap.full_name AS agent_name,
      b.bucket,
      count(*)::integer AS plan_count,
      SUM(b.arrears_ugx) AS arrears_ugx
    FROM bucketed b
    LEFT JOIN public.profiles ap ON ap.id = b.agent_id
    WHERE b.agent_id IS NOT NULL
    GROUP BY b.agent_id, ap.full_name, b.bucket
  )
  SELECT book.agent_id, book.agent_name, book.bucket, book.plan_count, book.arrears_ugx
  FROM book
  ORDER BY SUM(book.arrears_ugx) OVER (PARTITION BY book.agent_id) DESC, book.agent_id, book.bucket;
END;
$function$;

COMMENT ON FUNCTION public.tops_agent_arrears_book(date) IS
'One row per (agent, bucket) on the 1-7/8-14/15-30/30+ ladder. Server-ordered so a given agent''s bucket rows are contiguous and sorted by that agent''s total arrears descending, matching what useAgentArrearsBook.ts used to compute client-side (removed 2026-09-28 — see docs/TOPS_BUILD_LOG.md). Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 2. tops_pipeline_queue — gap_label moved into the CTE (was computed inline
--    in the old final SELECT) so it can be filtered on; two new trailing
--    DEFAULT-NULL params filter server-side instead of PipelineSection.tsx's
--    two client-side .filter() calls. NULL (the default) means "no filter",
--    so an existing caller that passes neither param sees identical rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_pipeline_queue(p_gap_label text DEFAULT NULL::text, p_owner_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(rent_request_id uuid, tenant_name text, agent_name text, current_stage_key text, current_stage_label text, gap_label text, owner_id uuid, owner_name text, stage_entered_at timestamp with time zone, age_days integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
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
  WITH plans AS (
    SELECT
      rr.id AS rent_request_id,
      rr.tenant_id,
      COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
      rr.approved_at,
      rr.approved_by,
      rr.funded_at
    FROM public.rent_requests rr
    LEFT JOIN public.tops_plan_clock c ON c.rent_request_id = rr.id
    WHERE rr.approved_at IS NOT NULL
      AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
      AND c.clock_start IS NULL
  ),
  float_alloc AS (
    SELECT
      a.rent_request_id,
      MIN(a.created_at) AS float_at,
      (array_agg(a.agent_id ORDER BY a.created_at))[1] AS float_agent
    FROM public.agent_landlord_float_allocations a
    GROUP BY a.rent_request_id
  ),
  landlord AS (
    SELECT
      lp.rent_request_id,
      COALESCE(MIN(lp.disbursed_at), MIN(lp.finops_disbursed_at)) AS landlord_paid_at,
      (array_agg(COALESCE(lp.finops_disbursed_by, lp.agent_id)
         ORDER BY COALESCE(lp.disbursed_at, lp.finops_disbursed_at)))[1] AS landlord_paid_actor,
      MIN(lp.receipt_uploaded_at) AS receipt_at
    FROM public.landlord_payouts lp
    GROUP BY lp.rent_request_id
  ),
  staged AS (
    SELECT
      p.rent_request_id, p.tenant_id, p.agent_id,
      p.approved_at, p.approved_by, p.funded_at,
      fa.float_at, fa.float_agent,
      l.landlord_paid_at, l.landlord_paid_actor, l.receipt_at
    FROM plans p
    LEFT JOIN float_alloc fa ON fa.rent_request_id = p.rent_request_id
    LEFT JOIN landlord l ON l.rent_request_id = p.rent_request_id
  ),
  current_stage AS (
    SELECT
      s.rent_request_id, s.tenant_id, s.agent_id,
      CASE
        WHEN s.receipt_at IS NOT NULL THEN 'receipt_confirmed'
        WHEN s.landlord_paid_at IS NOT NULL THEN 'landlord_paid'
        WHEN s.float_at IS NOT NULL THEN 'float_allocated'
        WHEN s.funded_at IS NOT NULL THEN 'funded'
        ELSE 'approved'
      END AS current_stage_key,
      CASE
        WHEN s.receipt_at IS NOT NULL THEN s.receipt_at
        WHEN s.landlord_paid_at IS NOT NULL THEN s.landlord_paid_at
        WHEN s.float_at IS NOT NULL THEN s.float_at
        WHEN s.funded_at IS NOT NULL THEN s.funded_at
        ELSE s.approved_at
      END AS stage_entered_at,
      CASE
        WHEN s.receipt_at IS NOT NULL THEN NULL::uuid
        WHEN s.landlord_paid_at IS NOT NULL THEN s.landlord_paid_actor
        WHEN s.float_at IS NOT NULL THEN s.float_agent
        WHEN s.funded_at IS NOT NULL THEN NULL::uuid
        ELSE s.approved_by
      END AS owner_id,
      CASE
        WHEN s.receipt_at IS NOT NULL THEN NULL::text
        WHEN s.landlord_paid_at IS NOT NULL THEN 'Landlord paid but clock not started'
        WHEN s.float_at IS NOT NULL THEN 'Funded but landlord unpaid'
        WHEN s.funded_at IS NOT NULL THEN 'Funded but landlord unpaid'
        ELSE 'Approved but unfunded'
      END AS gap_label
    FROM staged s
  )
  SELECT
    cs.rent_request_id,
    tp.full_name,
    ap.full_name,
    cs.current_stage_key,
    CASE cs.current_stage_key
      WHEN 'approved' THEN 'Approved'
      WHEN 'funded' THEN 'Funded'
      WHEN 'float_allocated' THEN 'Float allocated'
      WHEN 'landlord_paid' THEN 'Landlord paid'
      WHEN 'receipt_confirmed' THEN 'Receipt confirmed'
    END,
    cs.gap_label,
    cs.owner_id,
    op.full_name,
    cs.stage_entered_at,
    (v_now::date - cs.stage_entered_at::date)::integer
  FROM current_stage cs
  LEFT JOIN public.profiles tp ON tp.id = cs.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = cs.agent_id
  LEFT JOIN public.profiles op ON op.id = cs.owner_id
  WHERE (p_gap_label IS NULL OR cs.gap_label = p_gap_label)
    AND (p_owner_id IS NULL OR cs.owner_id = p_owner_id)
  ORDER BY (v_now::date - cs.stage_entered_at::date) DESC NULLS LAST;
END;
$function$;

COMMENT ON FUNCTION public.tops_pipeline_queue(text, uuid) IS
'Every plan stalled in the funding pipeline (approved, clock not yet started), oldest-stalled first. p_gap_label/p_owner_id (both default NULL = no filter) let the Pipeline tab and "waiting on my desk" toggle filter server-side instead of in the browser (removed 2026-09-28 — see docs/TOPS_BUILD_LOG.md). Pair with tops_pipeline_queue_gap_counts() for the tab badge counts, which must stay unfiltered. Gated by an internal has_role check.';

-- New: tab-badge counts, independent of whatever filter the main list is
-- currently viewing under — PipelineSection.tsx's badges must always show
-- the FULL counts per gap, not the currently-filtered subset.
CREATE OR REPLACE FUNCTION public.tops_pipeline_queue_gap_counts()
RETURNS TABLE(gap_label text, cnt integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p.gap_label, count(*)::integer
  FROM public.tops_pipeline_queue(NULL, NULL) p
  WHERE p.gap_label IS NOT NULL
  GROUP BY p.gap_label;
$function$;

REVOKE ALL ON FUNCTION public.tops_pipeline_queue_gap_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pipeline_queue_gap_counts() TO authenticated;

COMMENT ON FUNCTION public.tops_pipeline_queue_gap_counts() IS
'Unfiltered per-gap-label counts for the Pipeline tab''s tab badges, so switching the "waiting on my desk" toggle or a tab never changes what the OTHER tabs'' badges show. Delegates entirely to tops_pipeline_queue() with no filter, so it is has_role-gated one level down and needs no check of its own beyond that call succeeding — kept as a thin SQL wrapper, not duplicated logic.';

-- ---------------------------------------------------------------------------
-- 3. tops_plan_schedule_ledger — two new trailing DEFAULT params. p_limit
--    DEFAULT NULL preserves the exact old behaviour (every row, unbounded)
--    for any caller that omits it. The running-arrears balance is still
--    computed by walking every instalment in sequence order — pagination
--    only decides which of those already-computed rows get RETURNed, so a
--    later page's running total is exactly as correct as the first page's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_plan_schedule_ledger(p_rent_request_id uuid, p_limit integer DEFAULT NULL::integer, p_offset integer DEFAULT 0)
RETURNS TABLE(seq integer, due_date date, amount_ugx numeric, settled_ugx numeric, outstanding_ugx numeric, running_arrears_ugx numeric, settled_by jsonb, never_billed boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_first_pin date;
  v_running numeric(14,2) := 0;
  v_row record;
  v_idx integer := 0;
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

  SELECT MIN(aedp.day) INTO v_first_pin
  FROM public.agent_expected_day_plans aedp
  WHERE aedp.rent_request_id = p_rent_request_id;

  FOR v_row IN
    SELECT
      i.seq,
      i.due_date,
      i.amount_ugx,
      COALESCE(sd.settled_ugx, 0) AS settled_ugx,
      COALESCE(sb.settled_by, '[]'::jsonb) AS settled_by
    FROM public.tops_plan_instalments i
    LEFT JOIN (
      SELECT s.instalment_id, SUM(s.amount_ugx) AS settled_ugx
      FROM public.tops_instalment_settlements s
      WHERE s.released_at IS NULL
      GROUP BY s.instalment_id
    ) sd ON sd.instalment_id = i.id
    LEFT JOIN (
      SELECT
        s.instalment_id,
        jsonb_agg(
          jsonb_build_object(
            'collection_id', s.collection_id,
            'date', (ac.created_at AT TIME ZONE 'Africa/Kampala')::date,
            'channel', ac.collection_channel
          )
          ORDER BY ac.created_at
        ) AS settled_by
      FROM public.tops_instalment_settlements s
      JOIN public.agent_collections ac ON ac.id = s.collection_id
      WHERE s.released_at IS NULL
      GROUP BY s.instalment_id
    ) sb ON sb.instalment_id = i.id
    WHERE i.rent_request_id = p_rent_request_id
    ORDER BY i.seq
  LOOP
    v_running := GREATEST(0, v_running + (v_row.amount_ugx - v_row.settled_ugx));

    IF p_limit IS NULL OR (v_idx >= p_offset AND v_idx < p_offset + p_limit) THEN
      seq := v_row.seq;
      due_date := v_row.due_date;
      amount_ugx := v_row.amount_ugx;
      settled_ugx := v_row.settled_ugx;
      outstanding_ugx := v_row.amount_ugx - v_row.settled_ugx;
      running_arrears_ugx := v_running;
      settled_by := v_row.settled_by;
      never_billed := COALESCE(v_first_pin IS NOT NULL AND v_row.due_date < v_first_pin, false);
      RETURN NEXT;
    END IF;

    v_idx := v_idx + 1;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.tops_plan_schedule_ledger(uuid, integer, integer) IS
'One row per instalment for a plan, in seq order, with a running arrears balance walked over the WHOLE plan regardless of which page is requested (so a later page''s running total is exact, not reset at the page boundary). p_limit DEFAULT NULL returns every row (the old, still-supported behaviour); a caller that pages must also call tops_plan_schedule_ledger_count() for the total row count (added 2026-09-28 to replace ScheduleLedger.tsx''s in-memory paging — see docs/TOPS_BUILD_LOG.md). Gated by an internal has_role check.';

-- New: total instalment count for a plan, so the caller can page without
-- fetching every row first just to learn how many pages exist.
CREATE OR REPLACE FUNCTION public.tops_plan_schedule_ledger_count(p_rent_request_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  RETURN (SELECT count(*)::integer FROM public.tops_plan_instalments WHERE rent_request_id = p_rent_request_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_plan_schedule_ledger_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_plan_schedule_ledger_count(uuid) TO authenticated;

COMMENT ON FUNCTION public.tops_plan_schedule_ledger_count(uuid) IS
'Total instalment row count for one plan, paired with tops_plan_schedule_ledger()''s p_limit/p_offset so ScheduleLedger.tsx can page server-side. SECURITY DEFINER bypasses RLS, so this carries its own has_role check rather than relying on tops_plan_instalments'' SELECT policy.';

-- ---------------------------------------------------------------------------
-- 4. tops_collection_anomalies_list — two new trailing DEFAULT params.
--    p_limit DEFAULT NULL preserves the old unbounded-list behaviour.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_collection_anomalies_list(p_status text DEFAULT 'open'::text, p_limit integer DEFAULT NULL::integer, p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid, collection_id uuid, rent_request_id uuid, tenant_name text, agent_name text, collection_channel text, rule_fired text, severity text, detail jsonb, detected_at timestamp with time zone, status text, acknowledged_by_name text, acknowledged_at timestamp with time zone, acknowledged_note text, resolved_by_name text, resolved_at timestamp with time zone, resolved_note text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    a.id, a.collection_id, a.rent_request_id,
    tp.full_name, ap.full_name, a.collection_channel, a.rule_fired, a.severity, a.detail, a.detected_at,
    a.status, ackp.full_name, a.acknowledged_at, a.acknowledged_note,
    resp.full_name, a.resolved_at, a.resolved_note
  FROM public.tops_collection_anomalies a
  LEFT JOIN public.profiles tp ON tp.id = a.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = a.agent_id
  LEFT JOIN public.profiles ackp ON ackp.id = a.acknowledged_by
  LEFT JOIN public.profiles resp ON resp.id = a.resolved_by
  WHERE p_status IS NULL OR a.status = p_status
  ORDER BY a.severity = 'critical' DESC, a.severity = 'high' DESC, a.detected_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

COMMENT ON FUNCTION public.tops_collection_anomalies_list(text, integer, integer) IS
'Anomalies by status, severity-then-recency ordered. p_limit DEFAULT NULL returns every matching row (the old, still-supported behaviour); a caller that pages must also call tops_collection_anomalies_count() for the total row count (added 2026-09-28 so the Anomalies tab can page server-side — see docs/TOPS_BUILD_LOG.md). Gated by an internal has_role check.';

-- New: total count for a status, so the caller can page without fetching
-- every row first.
CREATE OR REPLACE FUNCTION public.tops_collection_anomalies_count(p_status text DEFAULT 'open'::text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  RETURN (SELECT count(*)::integer FROM public.tops_collection_anomalies a WHERE p_status IS NULL OR a.status = p_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_collection_anomalies_count(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_collection_anomalies_count(text) TO authenticated;

COMMENT ON FUNCTION public.tops_collection_anomalies_count(text) IS
'Total tops_collection_anomalies row count for a status, paired with tops_collection_anomalies_list()''s p_limit/p_offset. SECURITY DEFINER bypasses RLS, so this carries its own has_role check rather than relying on tops_collection_anomalies'' SELECT policy.';

-- ---------------------------------------------------------------------------
-- 5. Real bug caught by testing immediately after applying the above, not
--    assumed: CREATE OR REPLACE on tops_pipeline_queue/tops_plan_schedule_
--    ledger/tops_collection_anomalies_list ABOVE added trailing parameters,
--    which Postgres treats as a DIFFERENT function identity (name+arg-types)
--    from the original — so each CREATE OR REPLACE silently created a
--    SECOND overload instead of replacing the first. Two consequences,
--    both confirmed live before this fix:
--      (a) calling the old bare form (e.g. tops_pipeline_queue() with no
--          args) became ambiguous — Postgres cannot choose between the old
--          0-arg overload and the new 2-arg-with-defaults overload — and
--          errored "is not unique".
--      (b) each new overload is a BRAND NEW function object, so the
--          schema-wide default-privilege auto-grant (documented since this
--          build's first task) applied to it independently and granted it
--          EXECUTE straight to anon — confirmed live via aclexplode on the
--          new OIDs before this fix, not assumed from the pattern alone.
--    Fixed by dropping the three now-superseded old-signature overloads
--    (safe: their only callers were this workspace's own hooks, all updated
--    in this same task) and explicitly re-revoking anon/PUBLIC on the three
--    new ones, exactly the DROP-FUNCTION-resets-the-ACL lesson
--    scripts/guard-privileged-function-grants.mjs already defends for a
--    different, money-moving set of functions. Recorded here as a concrete
--    reminder that adding parameters via CREATE OR REPLACE is only safe
--    when Postgres can see it as the SAME signature (e.g. going from zero
--    parameters to one, is not) — this build's own past pattern of pure
--    ORDER BY changes never hit this because the signature never changed.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.tops_pipeline_queue();
DROP FUNCTION public.tops_plan_schedule_ledger(uuid);
DROP FUNCTION public.tops_collection_anomalies_list(text);

REVOKE ALL ON FUNCTION public.tops_pipeline_queue(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pipeline_queue(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.tops_plan_schedule_ledger(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_plan_schedule_ledger(uuid, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.tops_collection_anomalies_list(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_collection_anomalies_list(text, integer, integer) TO authenticated;
