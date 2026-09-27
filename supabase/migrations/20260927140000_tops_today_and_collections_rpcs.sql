-- Tenant Ops Workspace — Today tab (overnight changes, blocked items) and
-- Collections tab (due today, arrears ageing, movement, never billed).
--
-- Per docs/TOPS_RULES.md: new, read-only objects only. Reads existing tables
-- (rent_requests, agent_collections, agent_expected_day_plans,
-- landlord_payouts, v_agent_daily_eligibility) and our own tops_* tables.
-- Adds no column anywhere, writes nothing.
--
-- Reversal test throughout: reversed_at IS NULL, matching
-- tops_is_collection_reversed() (docs/TOPS_FINDINGS.md §5).
--
-- "Never billed" (an instalment whose due_date precedes a plan's first real
-- pinned day — same test as tops_plan_schedule_ledger.never_billed) is
-- excluded from every arrears/movement total below and surfaced only in
-- tops_never_billed(), per the brief. tops_open_instalments_asof() computes
-- this once so every tab reads the identical rule.

-- ---------------------------------------------------------------------------
-- 0. tops_open_instalments_asof — internal helper, not a client RPC.
--    Every currently-open (unsettled, due) instalment as of a date, with its
--    never_billed flag. No EXECUTE grant at all, including authenticated —
--    it has no pagination or role check of its own and exists purely for
--    the RPCs below to build on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_open_instalments_asof(p_as_at date)
RETURNS TABLE (
  rent_request_id uuid,
  instalment_id uuid,
  due_date date,
  amount_ugx numeric,
  settled_ugx numeric,
  outstanding_ugx numeric,
  never_billed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH settled AS (
    SELECT s.instalment_id, SUM(s.amount_ugx) AS settled_ugx
    FROM public.tops_instalment_settlements s
    JOIN public.agent_collections ac ON ac.id = s.collection_id
    WHERE s.released_at IS NULL
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= p_as_at
    GROUP BY s.instalment_id
  ),
  first_pin AS (
    SELECT rent_request_id, MIN(day) AS first_day
    FROM public.agent_expected_day_plans
    GROUP BY rent_request_id
  )
  SELECT
    i.rent_request_id,
    i.id AS instalment_id,
    i.due_date,
    i.amount_ugx,
    COALESCE(sd.settled_ugx, 0) AS settled_ugx,
    i.amount_ugx - COALESCE(sd.settled_ugx, 0) AS outstanding_ugx,
    COALESCE(fp.first_day IS NOT NULL AND i.due_date < fp.first_day, false) AS never_billed
  FROM public.tops_plan_instalments i
  LEFT JOIN settled sd ON sd.instalment_id = i.id
  LEFT JOIN first_pin fp ON fp.rent_request_id = i.rent_request_id
  WHERE i.due_date <= p_as_at
    AND (i.amount_ugx - COALESCE(sd.settled_ugx, 0)) > 0;
$$;

REVOKE ALL ON FUNCTION public.tops_open_instalments_asof(date) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_open_instalments_asof(date) IS
'Internal helper only (no EXECUTE grant, including authenticated): every open instalment as of a date, with never_billed. Backs tops_arrears_ageing, tops_collections_movement and tops_never_billed so all three agree on one definition.';

-- ---------------------------------------------------------------------------
-- Shared role-check pattern, inlined into every function below (matching
-- every other frontend-facing tops_* RPC in this build).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. tops_overnight_changes(p_as_at) — Today tab.
--
-- "Promises broken" has no data source today (docs/TOPS_FINDINGS.md /
-- investigation for this build: no structured promise-to-pay exists yet,
-- only a free-text feedback theme) — returned as an empty array with an
-- explicit note rather than a fabricated figure. It becomes real once a
-- later prompt (11/12) adds structured promises.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_overnight_changes(p_as_at date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_prev date := v_as_at - 1;
  v_rolled jsonb;
  v_completed jsonb;
  v_rolled_count integer;
  v_rolled_total numeric;
  v_rolled_items jsonb;
  v_completed_count integer;
  v_completed_total numeric;
  v_completed_items jsonb;
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

  DROP TABLE IF EXISTS tmp_rolled;
  CREATE TEMP TABLE tmp_rolled ON COMMIT DROP AS
  WITH today_open AS (
    SELECT rent_request_id, SUM(outstanding_ugx) AS arrears_ugx
    FROM public.tops_open_instalments_asof(v_as_at)
    WHERE NOT never_billed
    GROUP BY rent_request_id
  ),
  prev_open AS (
    SELECT DISTINCT rent_request_id
    FROM public.tops_open_instalments_asof(v_prev)
    WHERE NOT never_billed
  )
  SELECT t.rent_request_id, t.arrears_ugx, rr.tenant_id, rr.assigned_agent_id, rr.agent_id
  FROM today_open t
  JOIN public.rent_requests rr ON rr.id = t.rent_request_id
  WHERE NOT EXISTS (SELECT 1 FROM prev_open p WHERE p.rent_request_id = t.rent_request_id);

  SELECT
    count(*),
    COALESCE(sum(arrears_ugx), 0)
  INTO v_rolled_count, v_rolled_total
  FROM tmp_rolled;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rent_request_id', r.rent_request_id,
    'tenant_name', tp.full_name,
    'agent_name', ap.full_name,
    'arrears_ugx', r.arrears_ugx
  ) ORDER BY r.arrears_ugx DESC), '[]'::jsonb)
  INTO v_rolled_items
  FROM (SELECT * FROM tmp_rolled ORDER BY arrears_ugx DESC LIMIT 10) r
  LEFT JOIN public.profiles tp ON tp.id = r.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(r.assigned_agent_id, r.agent_id);

  v_rolled := jsonb_build_object(
    'count', v_rolled_count,
    'total_arrears_ugx', v_rolled_total,
    'items', v_rolled_items,
    'items_capped_at', 10
  );

  SELECT count(*), COALESCE(sum(rr.total_repayment), 0)
  INTO v_completed_count, v_completed_total
  FROM public.rent_requests rr
  WHERE rr.status = 'completed' AND rr.updated_at::date = v_as_at;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rent_request_id', rr.id,
    'tenant_name', tp.full_name,
    'total_repayment_ugx', rr.total_repayment
  ) ORDER BY rr.updated_at DESC), '[]'::jsonb)
  INTO v_completed_items
  FROM (
    SELECT * FROM public.rent_requests
    WHERE status = 'completed' AND updated_at::date = v_as_at
    ORDER BY updated_at DESC LIMIT 10
  ) rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id;

  v_completed := jsonb_build_object(
    'count', v_completed_count,
    'total_repayment_ugx', v_completed_total,
    'items', v_completed_items,
    'items_capped_at', 10
  );

  RETURN jsonb_build_object(
    'as_at', v_as_at,
    'rolled_into_arrears', v_rolled,
    'promises_broken', jsonb_build_object(
      'count', 0, 'items', '[]'::jsonb,
      'note', 'No structured promise-to-pay exists yet — added once a later prompt builds it.'
    ),
    'plans_completed', v_completed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_overnight_changes(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_overnight_changes(date) TO authenticated;

COMMENT ON FUNCTION public.tops_overnight_changes(date) IS
'Today tab: plans that rolled into arrears and plans completed since the previous Kampala day. promises_broken is a placeholder (count 0, explicit note) — no structured promise-to-pay exists yet. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 2. tops_blocked_items() — Today tab.
--
-- "Agents below float adequacy" reuses the existing, already-enforced
-- v_agent_daily_eligibility view and its 50% threshold (the same one
-- enforce_agent_daily_eligibility() blocks new rent requests on) — not a
-- new number invented for this screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_blocked_items()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_funded_unpaid jsonb;
  v_approved_unfunded jsonb;
  v_agents_below jsonb;
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

  SELECT jsonb_build_object(
    'count', (
      SELECT count(*) FROM public.rent_requests rr
      WHERE rr.funded_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts lp WHERE lp.rent_request_id = rr.id AND lp.otp_verified_at IS NOT NULL)
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('rent_request_id', rr.id, 'tenant_name', tp.full_name, 'funded_at', rr.funded_at) ORDER BY rr.funded_at ASC)
      FROM (
        SELECT * FROM public.rent_requests rr
        WHERE rr.funded_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts lp WHERE lp.rent_request_id = rr.id AND lp.otp_verified_at IS NOT NULL)
        ORDER BY rr.funded_at ASC LIMIT 10
      ) rr
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    ), '[]'::jsonb),
    'items_capped_at', 10
  ) INTO v_funded_unpaid;

  SELECT jsonb_build_object(
    'count', (
      SELECT count(*) FROM public.rent_requests rr
      WHERE rr.approved_at IS NOT NULL AND rr.funded_at IS NULL
        AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('rent_request_id', rr.id, 'tenant_name', tp.full_name, 'approved_at', rr.approved_at) ORDER BY rr.approved_at ASC)
      FROM (
        SELECT * FROM public.rent_requests rr
        WHERE rr.approved_at IS NOT NULL AND rr.funded_at IS NULL
          AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
        ORDER BY rr.approved_at ASC LIMIT 10
      ) rr
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    ), '[]'::jsonb),
    'items_capped_at', 10
  ) INTO v_approved_unfunded;

  SELECT jsonb_build_object(
    'count', (
      SELECT count(*) FROM public.v_agent_daily_eligibility e
      WHERE e.active_count > 0
        AND GREATEST(COALESCE(e.effective_pct,0), COALESCE(e.raw_today_pct,0), COALESCE(e.raw_yesterday_pct,0)) < 0.50
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'agent_id', e.agent_id,
        'agent_name', ap.full_name,
        'best_pct', ROUND(GREATEST(COALESCE(e.effective_pct,0), COALESCE(e.raw_today_pct,0), COALESCE(e.raw_yesterday_pct,0)) * 100, 1)
      ) ORDER BY GREATEST(COALESCE(e.effective_pct,0), COALESCE(e.raw_today_pct,0), COALESCE(e.raw_yesterday_pct,0)) ASC)
      FROM (
        SELECT * FROM public.v_agent_daily_eligibility e
        WHERE e.active_count > 0
          AND GREATEST(COALESCE(e.effective_pct,0), COALESCE(e.raw_today_pct,0), COALESCE(e.raw_yesterday_pct,0)) < 0.50
        ORDER BY GREATEST(COALESCE(e.effective_pct,0), COALESCE(e.raw_today_pct,0), COALESCE(e.raw_yesterday_pct,0)) ASC LIMIT 10
      ) e
      LEFT JOIN public.profiles ap ON ap.id = e.agent_id
    ), '[]'::jsonb),
    'items_capped_at', 10
  ) INTO v_agents_below;

  RETURN jsonb_build_object(
    'funded_landlord_unpaid', v_funded_unpaid,
    'approved_unfunded', v_approved_unfunded,
    'agents_below_adequacy', v_agents_below
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_blocked_items() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_blocked_items() TO authenticated;

COMMENT ON FUNCTION public.tops_blocked_items() IS
'Today tab: plans funded but the landlord not yet paid, plans approved but not yet funded, and agents below the existing 50% daily-collection-adequacy threshold (v_agent_daily_eligibility, the same view enforce_agent_daily_eligibility() already enforces). Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 3. tops_collections_due_today — Collections tab 1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_collections_due_today(
  p_as_at date DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_sort text DEFAULT 'expected_ugx',
  p_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_sign int := CASE WHEN lower(p_dir) = 'asc' THEN -1 ELSE 1 END;
  v_summary record;
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

  SELECT expected_ugx, collected_on_schedule_ugx, coverage_pct
  INTO v_summary
  FROM public.tops_collection_scoreboard(v_as_at, v_as_at);

  WITH bill AS (
    SELECT ep.rent_request_id, ep.expected_ugx, ep.agent_id, ep.tenant_id
    FROM public.agent_expected_day_plans ep
    WHERE ep.day = v_as_at
  ),
  cash AS (
    SELECT ac.rent_request_id, SUM(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_as_at
      AND ac.reversed_at IS NULL
    GROUP BY ac.rent_request_id
  ),
  base AS (
    SELECT
      b.rent_request_id,
      b.expected_ugx,
      LEAST(COALESCE(c.paid, 0), b.expected_ugx) AS paid_ugx,
      tp.full_name AS tenant_name,
      ap.full_name AS agent_name
    FROM bill b
    LEFT JOIN cash c ON c.rent_request_id = b.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = b.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = b.agent_id
  )
  SELECT count(*) INTO v_total_rows FROM base;

  WITH bill AS (
    SELECT ep.rent_request_id, ep.expected_ugx, ep.agent_id, ep.tenant_id
    FROM public.agent_expected_day_plans ep
    WHERE ep.day = v_as_at
  ),
  cash AS (
    SELECT ac.rent_request_id, SUM(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_as_at
      AND ac.reversed_at IS NULL
    GROUP BY ac.rent_request_id
  ),
  base AS (
    SELECT
      b.rent_request_id,
      b.expected_ugx,
      LEAST(COALESCE(c.paid, 0), b.expected_ugx) AS paid_ugx,
      tp.full_name AS tenant_name,
      ap.full_name AS agent_name
    FROM bill b
    LEFT JOIN cash c ON c.rent_request_id = b.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = b.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = b.agent_id
  )
  SELECT jsonb_agg(ranked.row_data)
  INTO v_rows
  FROM (
    SELECT
      jsonb_build_object(
        'rent_request_id', rent_request_id,
        'tenant_name', tenant_name,
        'agent_name', agent_name,
        'expected_ugx', expected_ugx,
        'paid_ugx', paid_ugx,
        'unpaid_ugx', expected_ugx - paid_ugx,
        'status', CASE
          WHEN paid_ugx >= expected_ugx THEN 'paid'
          WHEN paid_ugx > 0 THEN 'partial'
          ELSE 'unpaid'
        END
      ) AS row_data
    FROM base
    ORDER BY (CASE WHEN p_sort = 'paid_ugx' THEN paid_ugx ELSE expected_ugx END) * v_sign DESC
    LIMIT p_limit OFFSET p_offset
  ) ranked;

  v_rows := COALESCE(v_rows, '[]'::jsonb);

  RETURN jsonb_build_object(
    'as_at', v_as_at,
    'summary', jsonb_build_object(
      'billed_ugx', COALESCE(v_summary.expected_ugx, 0),
      'paid_ugx', COALESCE(v_summary.collected_on_schedule_ugx, 0),
      'unpaid_ugx', COALESCE(v_summary.expected_ugx, 0) - COALESCE(v_summary.collected_on_schedule_ugx, 0),
      'coverage_pct', v_summary.coverage_pct
    ),
    'total_row_count', v_total_rows,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_collections_due_today(date, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_collections_due_today(date, integer, integer, text, text) TO authenticated;

COMMENT ON FUNCTION public.tops_collections_due_today(date, integer, integer, text, text) IS
'Collections tab 1: plans billed on a Kampala day, each capped at what it owed that day, plus the same capped summary tops_collection_scoreboard(as_at, as_at) already computes. Server-paginated (p_limit/p_offset) and server-sorted (p_sort in expected_ugx|paid_ugx). Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 4. tops_arrears_ageing — Collections tab 2.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_arrears_ageing(
  p_as_at date DEFAULT NULL,
  p_bucket text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_sign int := CASE WHEN lower(p_dir) = 'asc' THEN -1 ELSE 1 END;
  v_summary jsonb;
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

  DROP TABLE IF EXISTS tmp_arrears_plans;
  CREATE TEMP TABLE tmp_arrears_plans ON COMMIT DROP AS
  SELECT
    o.rent_request_id,
    SUM(o.outstanding_ugx) AS arrears_ugx,
    MIN(o.due_date) AS oldest_due_date,
    (v_as_at - MIN(o.due_date)) AS age_days,
    CASE
      WHEN (v_as_at - MIN(o.due_date)) BETWEEN 1 AND 7 THEN '1-7'
      WHEN (v_as_at - MIN(o.due_date)) BETWEEN 8 AND 14 THEN '8-14'
      WHEN (v_as_at - MIN(o.due_date)) BETWEEN 15 AND 30 THEN '15-30'
      ELSE '30+'
    END AS bucket
  FROM public.tops_open_instalments_asof(v_as_at) o
  WHERE NOT o.never_billed
  GROUP BY o.rent_request_id;

  SELECT jsonb_object_agg(bucket, jsonb_build_object('count', cnt, 'arrears_ugx', total))
  INTO v_summary
  FROM (
    SELECT bucket, count(*) AS cnt, SUM(arrears_ugx) AS total
    FROM tmp_arrears_plans
    GROUP BY bucket
  ) b;

  SELECT count(*) INTO v_total_rows
  FROM tmp_arrears_plans
  WHERE p_bucket IS NULL OR bucket = p_bucket;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rent_request_id', t.rent_request_id,
    'tenant_name', tp.full_name,
    'agent_name', ap.full_name,
    'arrears_ugx', t.arrears_ugx,
    'oldest_due_date', t.oldest_due_date,
    'age_days', t.age_days,
    'bucket', t.bucket
  ) ORDER BY t.arrears_ugx * v_sign DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM tmp_arrears_plans
    WHERE p_bucket IS NULL OR bucket = p_bucket
    ORDER BY arrears_ugx * v_sign DESC
    LIMIT p_limit OFFSET p_offset
  ) t
  LEFT JOIN public.rent_requests rr ON rr.id = t.rent_request_id
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id);

  RETURN jsonb_build_object(
    'as_at', v_as_at,
    'summary', COALESCE(v_summary, '{}'::jsonb),
    'total_row_count', v_total_rows,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_arrears_ageing(date, text, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_arrears_ageing(date, text, integer, integer, text) TO authenticated;

COMMENT ON FUNCTION public.tops_arrears_ageing(date, text, integer, integer, text) IS
'Collections tab 2: per-plan arrears bucketed 1-7/8-14/15-30/30+ days past due, from tops_plan_instalments + tops_instalment_settlements via tops_open_instalments_asof(), excluding never-billed instalments. p_bucket filters the row list to one bucket (a summary tile click-through). Server-paginated and server-sorted by arrears_ugx. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 5. tops_collections_movement — Collections tab 3.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_collections_movement(
  p_from date,
  p_to date,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_summary jsonb;
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

  DROP TABLE IF EXISTS tmp_movement;
  CREATE TEMP TABLE tmp_movement ON COMMIT DROP AS
  WITH open_from AS (
    SELECT rent_request_id, SUM(outstanding_ugx) AS arrears_ugx
    FROM public.tops_open_instalments_asof(p_from)
    WHERE NOT never_billed
    GROUP BY rent_request_id
  ),
  open_to AS (
    SELECT rent_request_id, SUM(outstanding_ugx) AS arrears_ugx
    FROM public.tops_open_instalments_asof(p_to)
    WHERE NOT never_billed
    GROUP BY rent_request_id
  ),
  rolled_in AS (
    SELECT t.rent_request_id, t.arrears_ugx, 'rolled_in'::text AS movement_type
    FROM open_to t
    WHERE NOT EXISTS (SELECT 1 FROM open_from f WHERE f.rent_request_id = t.rent_request_id)
  ),
  recovered AS (
    SELECT f.rent_request_id, f.arrears_ugx, 'recovered'::text AS movement_type
    FROM open_from f
    WHERE NOT EXISTS (SELECT 1 FROM open_to t WHERE t.rent_request_id = f.rent_request_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.rent_requests rr WHERE rr.id = f.rent_request_id AND rr.status = 'completed'
      )
  ),
  completed AS (
    SELECT rr.id AS rent_request_id, rr.total_repayment AS arrears_ugx, 'completed'::text AS movement_type
    FROM public.rent_requests rr
    WHERE rr.status = 'completed' AND rr.updated_at::date > p_from AND rr.updated_at::date <= p_to
  )
  SELECT * FROM rolled_in
  UNION ALL SELECT * FROM recovered
  UNION ALL SELECT * FROM completed;

  SELECT jsonb_object_agg(movement_type, jsonb_build_object('count', cnt, 'amount_ugx', total))
  INTO v_summary
  FROM (
    SELECT movement_type, count(*) AS cnt, SUM(arrears_ugx) AS total
    FROM tmp_movement
    GROUP BY movement_type
  ) m;

  SELECT count(*) INTO v_total_rows FROM tmp_movement;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rent_request_id', t.rent_request_id,
    'tenant_name', tp.full_name,
    'agent_name', ap.full_name,
    'movement_type', t.movement_type,
    'amount_ugx', t.arrears_ugx
  ) ORDER BY t.movement_type, t.arrears_ugx DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM tmp_movement
    ORDER BY movement_type, arrears_ugx DESC
    LIMIT p_limit OFFSET p_offset
  ) t
  LEFT JOIN public.rent_requests rr ON rr.id = t.rent_request_id
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id);

  RETURN jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'summary', COALESCE(v_summary, '{}'::jsonb),
    'total_row_count', v_total_rows,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_collections_movement(date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_collections_movement(date, date, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.tops_collections_movement(date, date, integer, integer) IS
'Collections tab 3: plans that rolled into arrears, recovered out of arrears, or completed between two Kampala dates, excluding never-billed instalments throughout. Server-paginated. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 6. tops_never_billed — Collections tab 4.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_never_billed(
  p_as_at date DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_dir text DEFAULT 'desc'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_sign int := CASE WHEN lower(p_dir) = 'asc' THEN -1 ELSE 1 END;
  v_total_rows integer;
  v_total_ugx numeric;
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

  DROP TABLE IF EXISTS tmp_never_billed;
  CREATE TEMP TABLE tmp_never_billed ON COMMIT DROP AS
  SELECT
    o.rent_request_id,
    SUM(o.outstanding_ugx) AS never_billed_arrears_ugx,
    MIN(o.due_date) AS earliest_due_date
  FROM public.tops_open_instalments_asof(v_as_at) o
  WHERE o.never_billed
  GROUP BY o.rent_request_id;

  SELECT count(*), COALESCE(SUM(never_billed_arrears_ugx), 0) INTO v_total_rows, v_total_ugx FROM tmp_never_billed;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'rent_request_id', t.rent_request_id,
    'tenant_name', tp.full_name,
    'agent_name', ap.full_name,
    'never_billed_arrears_ugx', t.never_billed_arrears_ugx,
    'earliest_due_date', t.earliest_due_date
  ) ORDER BY t.never_billed_arrears_ugx * v_sign DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM tmp_never_billed
    ORDER BY never_billed_arrears_ugx * v_sign DESC
    LIMIT p_limit OFFSET p_offset
  ) t
  LEFT JOIN public.rent_requests rr ON rr.id = t.rent_request_id
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id);

  RETURN jsonb_build_object(
    'as_at', v_as_at,
    'summary', jsonb_build_object('count', v_total_rows, 'arrears_ugx', v_total_ugx),
    'explanation', 'These instalments fall due before this plan''s first pinned bill in agent_expected_day_plans. They carry real arrears but were never billed by the pin, so they are excluded from every other Collections total and shown only here.',
    'total_row_count', v_total_rows,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_never_billed(date, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_never_billed(date, integer, integer, text) TO authenticated;

COMMENT ON FUNCTION public.tops_never_billed(date, integer, integer, text) IS
'Collections tab 4: plans carrying arrears for due dates that precede their first pinned bill — excluded from due-today/arrears-ageing/movement, shown only here with a plain-language explanation. Server-paginated. Gated by an internal has_role check.';
