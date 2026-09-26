-- Tenant Ops Workspace — a collection scoreboard tab, and a metric catalogue
-- to go with it.
--
-- Per docs/TOPS_RULES.md: new objects only. This is deliberately a SEPARATE,
-- parallel coverage function from get_agent_collections_coverage() — Classic
-- will not call it, and get_agent_collections_coverage() is not touched by
-- this file in any way. The two differ on exactly one axis: Classic's
-- "collected_on_schedule" is uncapped (per docs/TOPS_FINDINGS.md's companion
-- skill notes: "Already fixed — two places, both uncapped"); this one caps
-- each plan's on-schedule contribution at what that plan owed for the
-- window, per docs/TOPS_RULES.md's whole parallel-source principle — two
-- honest readings of the same raw rows, not a replacement of either.
--
-- Reversal test: reversed_at IS NOT NULL, matching tops_is_collection_reversed()
-- and docs/TOPS_FINDINGS.md §5 — not the incomplete notes text marker that
-- get_agent_collections_coverage() and most of Classic still use.

-- ---------------------------------------------------------------------------
-- 1. tops_metric_definitions — a small, versioned catalogue: one row per
--    metric this scoreboard tab exposes, so a reader always has the exact
--    definition and basis a number on screen used, not just its name.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_metric_definitions (
  key text PRIMARY KEY,
  title text NOT NULL,
  definition text NOT NULL,
  basis text NOT NULL,
  owner_role text NOT NULL,
  implementing_function text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tops_metric_definitions IS
'Static metric catalogue for the Tenant Ops Workspace: one row per metric a workspace tab exposes, naming its title, plain-language definition, computation basis, owning role and implementing function. No client writes — only ever updated by a migration. Classic does not read this table.';

REVOKE ALL ON public.tops_metric_definitions FROM PUBLIC;
GRANT SELECT ON public.tops_metric_definitions TO authenticated;
ALTER TABLE public.tops_metric_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_metric_definitions_select_tops_roles ON public.tops_metric_definitions
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

INSERT INTO public.tops_metric_definitions (key, title, definition, basis, owner_role, implementing_function, version) VALUES
(
  'collection_scoreboard.expected_ugx',
  'Expected (pinned bill)',
  'Total rent billed for the selected range, read straight from the pinned daily/weekly expectations in agent_expected_day_plans. Never re-derived live from the schedule, which would read higher for the same reason a plan funded today is absent from today''s bill.',
  'kampala;pinned_bill',
  'tenant_ops',
  'tops_collection_scoreboard',
  1
),
(
  'collection_scoreboard.collected_on_schedule_ugx',
  'Collected on schedule (capped)',
  'Money collected against a plan that was billed somewhere in the range, capped per plan at what that plan''s bill for the range totalled. An overpayment on one plan can never mask a nonpayment on another.',
  'kampala;capped_per_tenant;reversals_excluded',
  'tenant_ops',
  'tops_collection_scoreboard',
  1
),
(
  'collection_scoreboard.collected_arrears_ugx',
  'Collected arrears',
  'Money collected in the range against a plan that had no pinned bill anywhere in that range — old debt, not this period''s obligation.',
  'kampala;reversals_excluded',
  'tenant_ops',
  'tops_collection_scoreboard',
  1
),
(
  'collection_scoreboard.total_cash_in_ugx',
  'Total cash in',
  'Every non-reversed collection recorded in the range, whether or not it landed against a pinned bill — the receipt book total, with no performance judgement attached.',
  'kampala;reversals_excluded',
  'tenant_ops',
  'tops_collection_scoreboard',
  1
),
(
  'collection_scoreboard.coverage_pct',
  'Coverage % (capped)',
  'collected_on_schedule_ugx divided by expected_ugx, as a percentage. Deliberately not clamped to 100: an honest figure should surface an anomaly, not hide it behind a ceiling.',
  'kampala;capped_per_tenant;reversals_excluded;not_clamped',
  'tenant_ops',
  'tops_collection_scoreboard',
  1
);

-- ---------------------------------------------------------------------------
-- 2. tops_collection_scoreboard(p_from, p_to) — one row per call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_collection_scoreboard(p_from date, p_to date)
RETURNS TABLE (
  expected_ugx numeric,
  collected_on_schedule_ugx numeric,
  collected_arrears_ugx numeric,
  total_cash_in_ugx numeric,
  coverage_pct numeric,
  basis text,
  as_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected numeric(14,2);
  v_on_schedule numeric(14,2);
  v_arrears numeric(14,2);
  v_total_cash numeric(14,2);
  v_coverage numeric;
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

  -- Expected: read directly from the pinned bill. Never re-derived, never written.
  SELECT COALESCE(SUM(ep.expected_ugx), 0)
  INTO v_expected
  FROM public.agent_expected_day_plans ep
  WHERE ep.day BETWEEN p_from AND p_to;

  -- Collected on schedule: a plan counts as "on schedule" for the whole range
  -- if it was billed on any day within it (matching the multi-day convention
  -- already established by get_agent_collections_coverage), capped at that
  -- plan's own total expected for the range so one plan's overpayment can
  -- never cover another plan's nonpayment.
  WITH bill AS (
    SELECT ep.rent_request_id, SUM(ep.expected_ugx) AS expected
    FROM public.agent_expected_day_plans ep
    WHERE ep.day BETWEEN p_from AND p_to
    GROUP BY ep.rent_request_id
  ),
  cash AS (
    SELECT ac.rent_request_id, SUM(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.reversed_at IS NULL
    GROUP BY ac.rent_request_id
  )
  SELECT COALESCE(SUM(LEAST(COALESCE(c.paid, 0), b.expected)), 0)
  INTO v_on_schedule
  FROM bill b
  LEFT JOIN cash c ON c.rent_request_id = b.rent_request_id;

  -- Collected arrears: cash in the range against a plan billed nowhere in it.
  WITH bill_ids AS (
    SELECT DISTINCT ep.rent_request_id
    FROM public.agent_expected_day_plans ep
    WHERE ep.day BETWEEN p_from AND p_to
  )
  SELECT COALESCE(SUM(ac.amount), 0)
  INTO v_arrears
  FROM public.agent_collections ac
  WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    AND ac.reversed_at IS NULL
    AND (ac.rent_request_id IS NULL OR ac.rent_request_id NOT IN (SELECT rent_request_id FROM bill_ids));

  -- Total cash in: every non-reversed collection in the range, on or off bill.
  SELECT COALESCE(SUM(ac.amount), 0)
  INTO v_total_cash
  FROM public.agent_collections ac
  WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    AND ac.reversed_at IS NULL;

  -- Deliberately no LEAST(..., 100) here or anywhere above.
  v_coverage := ROUND(100.0 * v_on_schedule / NULLIF(v_expected, 0), 1);

  RETURN QUERY SELECT
    v_expected, v_on_schedule, v_arrears, v_total_cash, v_coverage,
    'kampala;pinned_bill;capped_per_tenant;reversals_excluded'::text, now();
END;
$$;

REVOKE ALL ON FUNCTION public.tops_collection_scoreboard(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_collection_scoreboard(date, date) TO authenticated;

COMMENT ON FUNCTION public.tops_collection_scoreboard(date, date) IS
'Read RPC for the Tenant Ops Workspace collection scoreboard tab: expected (pinned bill), collected on schedule (capped per plan), collected arrears, total cash in, and capped coverage % for a Kampala date range. A separate, parallel reading from get_agent_collections_coverage() (which is uncapped) — Classic does not call this. Gated by an internal has_role check (tenant_ops/operations/coo/cfo/ceo/super_admin) — EXECUTE is granted to authenticated, but an unauthorized caller gets an exception.';
