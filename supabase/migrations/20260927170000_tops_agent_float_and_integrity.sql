-- Tenant Ops Workspace — agent float adequacy, attainment, capacity, book,
-- and integrity signals. Per docs/TOPS_RULES.md: new, additive objects only.
--
-- A tenant who would not pay is a credit event. An agent who could not
-- collect is a liquidity event. This file is entirely about the second kind
-- — nothing here judges a tenant, and nothing here computes an incentive or
-- league-table figure for an agent.
--
-- Sources read (never written): agent_expected_day_plans (the PINNED bill,
-- read as-is, never re-derived), agent_collections, general_ledger,
-- rent_requests, tenant_transfers, tenant_reassignment_audit,
-- vw_agent_ops_directory (agent identity/active flag), v_agent_daily_eligibility
-- (the existing capacity/eligibility gate — read only, never recomputed),
-- and get_user_wallet_view() (the one authoritative wallet-balance read path,
-- per docs/TOPS_FINDINGS.md §10 — wallets.float_balance is never read directly).
--
-- Cron-safety lesson carried over from the previous task's real bug: a
-- has_role-gated function cannot be called from a cron job (no session, no
-- JWT, auth.uid() is NULL there). So the float-adequacy computation is split
-- from the start into an internal, ungated core and a thin gated wrapper —
-- the cron snapshot job calls only the internal core, never the wrapper.

-- ---------------------------------------------------------------------------
-- 1. tops_agent_float_adequacy_internal — the actual computation, no auth
--    gate, no client EXECUTE grant. Only ever called from another
--    SECURITY DEFINER tops_ function (the wrapper below, and the cron
--    snapshot writer in section 2).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_float_adequacy_internal(p_for_date date)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  float_balance_ugx numeric,
  expected_obligation_ugx numeric,
  adequacy_ratio numeric,
  shortfall_ugx numeric,
  tenants_at_risk integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH active_agents AS (
    -- "Active agent" = currently has at least one live (funded/repaying)
    -- plan — NOT "holds the agent role and isn't frozen" (that would be
    -- ~58,000+ rows, since nearly every user in this system holds the agent
    -- role; a research pass confirmed only ~98 agents actually have a live
    -- plan today). Deliberately not filtered on is_frozen either: a frozen
    -- agent can still be mid-collection on live plans, and float adequacy is
    -- arguably more urgent to see for them, not less.
    SELECT DISTINCT COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'repaying')
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
  ),
  named_agents AS (
    SELECT a.agent_id, d.full_name
    FROM active_agents a
    LEFT JOIN public.vw_agent_ops_directory d ON d.agent_id = a.agent_id
  ),
  obligation AS (
    -- The PINNED bill for this date, read as-is (agent_expected_day_plans is
    -- write-once per day per plan) — never re-derived from the live schedule.
    SELECT ep.agent_id, SUM(ep.expected_ugx) AS expected_obligation_ugx
    FROM public.agent_expected_day_plans ep
    WHERE ep.day = p_for_date
    GROUP BY ep.agent_id
  ),
  open_plans AS (
    SELECT o.rent_request_id, MIN(o.due_date) AS oldest_due_date
    FROM public.tops_open_instalments_asof(p_for_date) o
    WHERE NOT o.never_billed
    GROUP BY o.rent_request_id
  ),
  at_risk AS (
    -- "At risk" here reuses the same 15+ day threshold that already splits
    -- at_risk/critical from watch/new elsewhere in this workspace (the
    -- tops_arrears_ageing bucket ladder). Attributed to the CURRENT agent
    -- assignment (assigned_agent_id, falling back to agent_id — the same
    -- resolution tops_arrears_ageing already uses), not the pinned-bill
    -- agent above: this is about who is responsible for collecting a
    -- currently-open account today, which can differ from who was billed
    -- when the bill was pinned if the plan was reassigned since.
    SELECT COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id, count(DISTINCT rr.tenant_id) AS tenants_at_risk
    FROM open_plans op
    JOIN public.rent_requests rr ON rr.id = op.rent_request_id
    WHERE (p_for_date - op.oldest_due_date) >= 15
    GROUP BY COALESCE(rr.assigned_agent_id, rr.agent_id)
  ),
  wallet AS (
    SELECT a.agent_id, COALESCE((public.get_user_wallet_view(a.agent_id) ->> 'float_balance')::numeric, 0) AS float_balance_ugx
    FROM active_agents a
  )
  SELECT
    a.agent_id,
    a.full_name,
    COALESCE(w.float_balance_ugx, 0),
    COALESCE(o.expected_obligation_ugx, 0),
    CASE WHEN COALESCE(o.expected_obligation_ugx, 0) = 0 THEN NULL
         ELSE ROUND(COALESCE(w.float_balance_ugx, 0) / o.expected_obligation_ugx, 4)
    END,
    GREATEST(COALESCE(o.expected_obligation_ugx, 0) - COALESCE(w.float_balance_ugx, 0), 0),
    COALESCE(ar.tenants_at_risk, 0)::integer
  FROM named_agents a
  LEFT JOIN obligation o ON o.agent_id = a.agent_id
  LEFT JOIN wallet w ON w.agent_id = a.agent_id
  LEFT JOIN at_risk ar ON ar.agent_id = a.agent_id;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_agent_float_adequacy_internal(date) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_agent_float_adequacy_internal(date) IS
'Internal-only core of agent float adequacy — no has_role gate, no client EXECUTE grant. Exists so the cron snapshot writer (no session, no JWT) can compute this without hitting the auth.uid()-is-NULL problem a client-facing gated function would have from cron. "Active agent" = has a live funded/repaying plan today (~98 agents), not "holds the agent role and is not frozen" (~58,000+ agents — nearly every user holds the agent role). Called only by tops_agent_float_adequacy() (the gated client wrapper) and tops_snapshot_agent_float_adequacy() (the cron writer).';

-- ---------------------------------------------------------------------------
-- 2. tops_agent_float_adequacy — the client-facing, role-gated wrapper.
--    Exact signature and return shape the brief named.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_float_adequacy(p_for_date date)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  float_balance_ugx numeric,
  expected_obligation_ugx numeric,
  adequacy_ratio numeric,
  shortfall_ugx numeric,
  tenants_at_risk integer
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

  RETURN QUERY SELECT * FROM public.tops_agent_float_adequacy_internal(p_for_date);
END;
$$;

REVOKE ALL ON FUNCTION public.tops_agent_float_adequacy(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_agent_float_adequacy(date) TO authenticated;

COMMENT ON FUNCTION public.tops_agent_float_adequacy(date) IS
'One row per active agent (vw_agent_ops_directory, not frozen): float_balance_ugx from get_user_wallet_view() (the authoritative wallet read path — wallets.float_balance is never read directly), expected_obligation_ugx from the PINNED bill in agent_expected_day_plans for p_for_date (read as-is, never re-derived), adequacy_ratio = float/obligation (null when obligation is zero), shortfall_ugx, and tenants_at_risk (distinct tenants on a currently-assigned plan at least 15 days past due). Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 3. tops_float_adequacy_snapshots — one row per agent per day, written the
--    evening before by the cron job below, so the gap is known in advance.
--    Retained 180 days (pruned by the same cron function).
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_float_adequacy_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  for_date date NOT NULL,
  float_balance_ugx numeric(14,2) NOT NULL,
  expected_obligation_ugx numeric(14,2) NOT NULL,
  adequacy_ratio numeric,
  shortfall_ugx numeric(14,2) NOT NULL,
  tenants_at_risk integer NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, for_date)
);

CREATE INDEX tops_float_adequacy_snapshots_for_date_idx ON public.tops_float_adequacy_snapshots (for_date);
CREATE INDEX tops_float_adequacy_snapshots_agent_idx ON public.tops_float_adequacy_snapshots (agent_id, for_date DESC);

COMMENT ON TABLE public.tops_float_adequacy_snapshots IS
'One row per agent per day, captured at 18:00 EAT for the NEXT day by tops_snapshot_agent_float_adequacy() (cron: tops-snapshot-agent-float-adequacy-1800-eat, schedule 0 15 * * * UTC = 18:00 Africa/Kampala), so a float gap is known the evening before it becomes today''s problem. Retained 180 days, pruned by the same cron function. Read-only from the client — no client write path exists.';

REVOKE ALL ON public.tops_float_adequacy_snapshots FROM PUBLIC, anon;
GRANT SELECT ON public.tops_float_adequacy_snapshots TO authenticated;
ALTER TABLE public.tops_float_adequacy_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_float_adequacy_snapshots_select_tops_roles ON public.tops_float_adequacy_snapshots
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE OR REPLACE FUNCTION public.tops_snapshot_agent_float_adequacy()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_for_date date := ((now() AT TIME ZONE 'Africa/Kampala')::date) + 1;
  v_count integer := 0;
BEGIN
  INSERT INTO public.tops_float_adequacy_snapshots
    (agent_id, for_date, float_balance_ugx, expected_obligation_ugx, adequacy_ratio, shortfall_ugx, tenants_at_risk)
  SELECT agent_id, v_for_date, float_balance_ugx, expected_obligation_ugx, adequacy_ratio, shortfall_ugx, tenants_at_risk
  FROM public.tops_agent_float_adequacy_internal(v_for_date)
  ON CONFLICT (agent_id, for_date) DO UPDATE SET
    float_balance_ugx = EXCLUDED.float_balance_ugx,
    expected_obligation_ugx = EXCLUDED.expected_obligation_ugx,
    adequacy_ratio = EXCLUDED.adequacy_ratio,
    shortfall_ugx = EXCLUDED.shortfall_ugx,
    tenants_at_risk = EXCLUDED.tenants_at_risk,
    captured_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM public.tops_float_adequacy_snapshots
  WHERE for_date < ((now() AT TIME ZONE 'Africa/Kampala')::date) - 180;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_snapshot_agent_float_adequacy() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_snapshot_agent_float_adequacy() IS
'Cron entry point (tops-snapshot-agent-float-adequacy-1800-eat, 0 15 * * * UTC = 18:00 Africa/Kampala): snapshots tomorrow''s agent float adequacy via the internal, ungated core (never the has_role-gated wrapper — cron has no session), upserts idempotently per (agent_id, for_date), and prunes rows older than 180 days. Internal-only, no EXECUTE grant to any client role.';

SELECT cron.schedule(
  'tops-snapshot-agent-float-adequacy-1800-eat',
  '0 15 * * *',
  $$ SELECT public.tops_snapshot_agent_float_adequacy(); $$
);

-- ---------------------------------------------------------------------------
-- 4. tops_agent_attainment(p_from, p_to) — per-agent reading of the exact
--    same basis tops_collection_scoreboard already established (pinned
--    bill, capped-per-plan, reversals excluded), grouped by the BILLED
--    agent (agent_expected_day_plans.agent_id, captured at pin time) rather
--    than the portfolio total. No incentive figure, no rank column — the
--    frontend must not render this as a leaderboard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_attainment(p_from date, p_to date)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  expected_ugx numeric,
  collected_on_schedule_ugx numeric,
  coverage_pct numeric,
  attribution_caveat text,
  basis text
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
  WITH bill AS (
    SELECT ep.agent_id, ep.rent_request_id, SUM(ep.expected_ugx) AS expected
    FROM public.agent_expected_day_plans ep
    WHERE ep.day BETWEEN p_from AND p_to
    GROUP BY ep.agent_id, ep.rent_request_id
  ),
  cash AS (
    SELECT ac.rent_request_id, SUM(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.reversed_at IS NULL
    GROUP BY ac.rent_request_id
  ),
  per_agent AS (
    SELECT
      b.agent_id,
      SUM(b.expected) AS expected_ugx,
      SUM(LEAST(COALESCE(c.paid, 0), b.expected)) AS collected_on_schedule_ugx
    FROM bill b
    LEFT JOIN cash c ON c.rent_request_id = b.rent_request_id
    GROUP BY b.agent_id
  )
  SELECT
    pa.agent_id,
    ap.full_name,
    pa.expected_ugx,
    pa.collected_on_schedule_ugx,
    ROUND(100.0 * pa.collected_on_schedule_ugx / NULLIF(pa.expected_ugx, 0), 1),
    'The agent billed for a plan (this row) is not always the agent who logged the collection against it — a plan reassigned mid-cycle can be billed to one agent while collected under another. This figure is not a settled attribution.'::text,
    'kampala;pinned_bill;capped_per_tenant;reversals_excluded;billed_agent_not_collecting_agent'::text
  FROM per_agent pa
  LEFT JOIN public.profiles ap ON ap.id = pa.agent_id;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_agent_attainment(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_agent_attainment(date, date) TO authenticated;

COMMENT ON FUNCTION public.tops_agent_attainment(date, date) IS
'Per-agent reading of the same basis tops_collection_scoreboard uses (pinned bill, capped-per-plan collected-on-schedule, reversals excluded), grouped by the agent the bill was pinned to. Carries an explicit attribution_caveat: the billed agent and the collecting agent can differ (reassignment mid-cycle). No incentive figure, no rank/percentile column — must not be rendered as a leaderboard. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 5. tops_agent_arrears_book(p_as_at) — each agent's currently-assigned
--    book, bucketed on the exact same 1-7/8-14/15-30/30+ ladder
--    tops_arrears_ageing already established. Read-only aggregate — no new
--    computation of "past due", only tops_open_instalments_asof reused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_arrears_book(p_as_at date DEFAULT NULL)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  bucket text,
  plan_count integer,
  arrears_ugx numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
  )
  SELECT
    b.agent_id,
    ap.full_name,
    b.bucket,
    count(*)::integer,
    SUM(b.arrears_ugx)
  FROM bucketed b
  LEFT JOIN public.profiles ap ON ap.id = b.agent_id
  WHERE b.agent_id IS NOT NULL
  GROUP BY b.agent_id, ap.full_name, b.bucket;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_agent_arrears_book(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_agent_arrears_book(date) TO authenticated;

COMMENT ON FUNCTION public.tops_agent_arrears_book(date) IS
'Each currently-assigned agent''s book of open arrears, bucketed 1-7/8-14/15-30/30+ days past due — the identical ladder and instalment source (tops_open_instalments_asof) tops_arrears_ageing already uses, just grouped by agent instead of listed per plan. One row per (agent, bucket) with at least one plan in it. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 6. tops_agent_integrity_signals(p_from, p_to) — reversed collections,
--    balance-correction frequency, transfer churn. Every figure a count or
--    a raw sum of an existing, already-recorded event — nothing inferred.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_integrity_signals(p_from date, p_to date)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  reversed_collections_count integer,
  reversed_collections_ugx numeric,
  balance_correction_count integer,
  transfer_churn_count integer
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
  WITH active_agents AS (
    -- Same "has a live plan" definition as tops_agent_float_adequacy_internal
    -- — not "holds the agent role and is not frozen" (~58,000+ agents).
    SELECT DISTINCT COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'repaying')
      AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
  ),
  named_agents AS (
    SELECT a.agent_id, d.full_name
    FROM active_agents a
    LEFT JOIN public.vw_agent_ops_directory d ON d.agent_id = a.agent_id
  ),
  reversed AS (
    -- reversed_at IS NOT NULL — the authoritative, complete marker
    -- (docs/TOPS_FINDINGS.md §5), never the incomplete notes text check.
    SELECT ac.agent_id, count(*)::integer AS cnt, SUM(ac.amount) AS total_ugx
    FROM public.agent_collections ac
    WHERE ac.reversed_at IS NOT NULL
      AND (ac.reversed_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY ac.agent_id
  ),
  corrections AS (
    -- Deliberately NOT general_ledger.category ILIKE '%correction%': that
    -- category is 99%+ dominated by an automated daily office-food credit
    -- posted under 'system_balance_correction' (confirmed live: 10,647 of
    -- ~10,763 such rows), which would swamp any real signal. The two
    -- purpose-built manual-correction tables, confirmed live by a research
    -- pass, are used instead: platform_wallet_corrections (excluding
    -- system_authored=true, which is that same automated credit) and
    -- error_correction_audit (status='posted' only).
    --
    -- events.agent_id is qualified below (not a bare "agent_id") because
    -- this function's own RETURNS TABLE column is also named agent_id —
    -- PL/pgSQL resolves a bare reference to the OUT parameter first, not
    -- the subquery column, which silently breaks the GROUP BY (caught only
    -- by actually invoking this function, not by the migration applying).
    SELECT events.agent_id, count(*)::integer AS cnt FROM (
      SELECT pwc.target_user_id AS agent_id, pwc.created_at
      FROM public.platform_wallet_corrections pwc
      WHERE COALESCE(pwc.system_authored, false) = false
      UNION ALL
      SELECT eca.target_user_id AS agent_id, eca.created_at
      FROM public.error_correction_audit eca
      WHERE eca.status = 'posted'
    ) events
    WHERE (events.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY events.agent_id
  ),
  churn AS (
    -- Same qualification reason as corrections above.
    SELECT events.agent_id, count(*)::integer AS cnt FROM (
      SELECT t.from_agent_id AS agent_id, t.created_at FROM public.tenant_transfers t
      UNION ALL
      SELECT t.to_agent_id AS agent_id, t.created_at FROM public.tenant_transfers t
      UNION ALL
      SELECT r.old_agent_id AS agent_id, r.created_at FROM public.tenant_reassignment_audit r
      UNION ALL
      SELECT r.new_agent_id AS agent_id, r.created_at FROM public.tenant_reassignment_audit r
    ) events
    WHERE events.agent_id IS NOT NULL
      AND (events.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY events.agent_id
  )
  SELECT
    a.agent_id,
    a.full_name,
    COALESCE(r.cnt, 0),
    COALESCE(r.total_ugx, 0),
    COALESCE(c.cnt, 0),
    COALESCE(ch.cnt, 0)
  FROM named_agents a
  LEFT JOIN reversed r ON r.agent_id = a.agent_id
  LEFT JOIN corrections c ON c.agent_id = a.agent_id
  LEFT JOIN churn ch ON ch.agent_id = a.agent_id;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_agent_integrity_signals(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_agent_integrity_signals(date, date) TO authenticated;

COMMENT ON FUNCTION public.tops_agent_integrity_signals(date, date) IS
'Reversed collections (agent_collections.reversed_at IS NOT NULL — the complete marker, not the incomplete notes text check; note one bulk de-duplication incident on 2026-09-16 accounts for ~95% of all reversed rows ever recorded, so a window spanning that date will look anomalous for that reason, not a live problem), balance-correction frequency (platform_wallet_corrections excluding system_authored + error_correction_audit where posted — not general_ledger, whose correction category is dominated by an unrelated automated daily credit), and transfer churn (tenant_transfers + tenant_reassignment_audit, either side, existing tables — read via the same sources get_tenant_transfer_history() already reads, not a new transfer log). One row per active agent (has a live funded/repaying plan), zero-filled. Gated by an internal has_role check.';

-- ---------------------------------------------------------------------------
-- 7. tops_agent_capacity_eligibility() — a read-only pass-through of the
--    EXISTING capacity/eligibility gate (v_agent_daily_eligibility), per the
--    brief: read it, never recompute or modify it. Note, not fixed (rule 9 —
--    we quarantine, we do not correct an existing object): this view does
--    NOT filter reversed_at IS NULL anywhere in its own definition, unlike
--    every tops_ object in this build. A same-day reversal can still
--    inflate today_pct/effective_pct there. Shown as-is, flagged here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_agent_capacity_eligibility()
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  active_count integer,
  expected_daily numeric,
  paid_today numeric,
  today_pct numeric,
  effective_pct numeric,
  tenants_due integer,
  tenants_paid_today integer,
  coverage_today numeric,
  weekly_plan_count integer,
  weekly_lapsed_count integer
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
    e.agent_id,
    ap.full_name,
    e.active_count,
    e.expected_daily,
    e.paid_today,
    e.today_pct,
    e.effective_pct,
    e.tenants_due,
    e.tenants_paid_today,
    e.coverage_today,
    e.weekly_plan_count,
    e.weekly_lapsed_count
  FROM public.v_agent_daily_eligibility e
  LEFT JOIN public.profiles ap ON ap.id = e.agent_id
  WHERE e.agent_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_agent_capacity_eligibility() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_agent_capacity_eligibility() TO authenticated;

COMMENT ON FUNCTION public.tops_agent_capacity_eligibility() IS
'Read-only pass-through of the EXISTING capacity/eligibility gate, v_agent_daily_eligibility (the same view enforce_agent_daily_eligibility() enforces at 50%) — never recomputed, never modified, per docs/TOPS_RULES.md rule 2. Caveat, not fixed (rule 9): that view does not filter reversed_at IS NULL anywhere in its own definition, unlike every tops_ object in this build, so a same-day reversal can inflate its percentages — shown as-is, flagged in this comment and in the build log, not corrected. Gated by an internal has_role check.';
