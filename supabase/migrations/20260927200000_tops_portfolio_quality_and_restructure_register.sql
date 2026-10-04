-- Tenant Ops Workspace — Weekly tab's portfolio-quality panel.
--
-- Per docs/TOPS_RULES.md: the EXISTING weekly performance hooks
-- (useTenantOpsWeeklyPerformance/useTenantOpsWeeklyHistory) and the frozen
-- weekly snapshot (tenant_ops_weekly_metrics, via
-- get_tenant_ops_weekly_performance/get_tenant_ops_weekly_history) are
-- reused unchanged from the frontend — nothing in this migration touches
-- them, rebuilds them, or re-derives what they already compute. This
-- migration only adds the NEW portfolio-at-risk/repayment/completion/repeat
-- reading the brief asked for, which nothing existing provides.
--
-- Recorded here, not acted on (rule 4 — an existing function that cannot
-- serve us unchanged gets a new additive equivalent, not an edit): those
-- existing weekly RPCs are has_role-gated to
-- operations/coo/ceo/super_admin/manager/cto — NOT tenant_ops or cfo, two of
-- this workspace's six roles. Building a tops_ access wrapper around them
-- was deliberately NOT done, since the brief explicitly says "do not...
-- extend them" and a wrapper would extend their reachable audience; the gap
-- is disclosed in the build log for a human to decide instead.

-- ---------------------------------------------------------------------------
-- 1. tops_restructure_register — plans touched by pause, renew, or reopen,
--    detected from records that already exist (rent_repayment_pauses,
--    rent_requests.registration_type, audit_logs), per docs/TOPS_FINDINGS.md
--    §7's confirmed sources. NO trigger on any existing table — this is a
--    polling read, refreshed on our own schedule by the function below.
--    Append-only by design: once a plan is flagged, it is never removed —
--    "plans in the register stay in the PAR numerator regardless of current
--    status" is enforced by tops_portfolio_quality simply never excluding a
--    registered plan, not by anything in this table expiring.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tops_restructure_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  restructure_type text NOT NULL CHECK (restructure_type IN ('pause', 'renewed_predecessor', 'reopened')),
  source_detail text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rent_request_id, restructure_type)
);

CREATE INDEX tops_restructure_register_rent_request_idx ON public.tops_restructure_register (rent_request_id);

COMMENT ON TABLE public.tops_restructure_register IS
'Plans touched by pause, renewal, or reopen, detected by polling existing records (rent_repayment_pauses; rent_requests.registration_type = renewal, with the predecessor identified by the same tenant_id+created_at-ordering inference docs/TOPS_FINDINGS.md §7 flags as a genuine inference, not a stored fact; audit_logs.action_type = rent_request_reopened). No trigger exists on any of those tables — this is populated by tops_refresh_restructure_register() polling on its own schedule. Append-only: a plan is never removed once flagged, so it stays in tops_portfolio_quality''s PAR numerator regardless of its later status, per the brief. Read-only from the client.';

REVOKE ALL ON public.tops_restructure_register FROM PUBLIC, anon;
GRANT SELECT ON public.tops_restructure_register TO authenticated;
ALTER TABLE public.tops_restructure_register ENABLE ROW LEVEL SECURITY;

CREATE POLICY tops_restructure_register_select_tops_roles ON public.tops_restructure_register
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
-- 2. tops_refresh_restructure_register() — the polling function. Internal
--    only, no has_role gate (cron-safe from the start — no session, no JWT,
--    per the lesson from an earlier task's real bug). Three independent
--    sweeps, each idempotent via ON CONFLICT DO NOTHING.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_refresh_restructure_register()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_inserted integer;
BEGIN
  -- Pause: rent_repayment_pauses is the reliable record (confirmed live —
  -- the pinned bill keeps billing straight through an active pause, so it
  -- cannot be used to detect one; this table is the only trustworthy source).
  INSERT INTO public.tops_restructure_register (rent_request_id, restructure_type, source_detail)
  SELECT DISTINCT p.rent_request_id, 'pause', 'rent_repayment_pauses'
  FROM public.rent_repayment_pauses p
  ON CONFLICT (rent_request_id, restructure_type) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_count := v_count + v_inserted;

  -- Renewed (predecessor): registration_type = 'renewal' is a direct, always
  -- populated fact, not inferred. The PREDECESSOR plan it renewed FROM has no
  -- stored link (docs/TOPS_FINDINGS.md §7's "Renewal linkage" blocker) — the
  -- predecessor is inferred as the tenant's most recent prior rent_requests
  -- row, exactly the inference FINDINGS itself names as usable-with-disclosure.
  -- This is the plan we flag (not the new renewal row), since it is the
  -- predecessor's risk that a renewal can otherwise make disappear from PAR.
  INSERT INTO public.tops_restructure_register (rent_request_id, restructure_type, source_detail)
  SELECT x.predecessor_id, 'renewed_predecessor', 'inferred predecessor of renewal ' || x.renewal_id::text
  FROM (
    SELECT
      renewal.id AS renewal_id,
      (
        SELECT r2.id FROM public.rent_requests r2
        WHERE r2.tenant_id = renewal.tenant_id
          AND r2.id <> renewal.id
          AND r2.created_at < renewal.created_at
        ORDER BY r2.created_at DESC
        LIMIT 1
      ) AS predecessor_id
    FROM public.rent_requests renewal
    WHERE renewal.registration_type = 'renewal'
  ) x
  WHERE x.predecessor_id IS NOT NULL
  ON CONFLICT (rent_request_id, restructure_type) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_count := v_count + v_inserted;

  -- Reopened: audit_logs.action_type = 'rent_request_reopened' is the sole
  -- trustworthy marker (confirmed live: reopen_count/reopened_at are ALSO
  -- mutated by force_approve_rejected_rent_request,
  -- return_rent_request_for_correction, and agent_resubmit_rent_request —
  -- using those columns alone would misclassify all three as "reopened").
  INSERT INTO public.tops_restructure_register (rent_request_id, restructure_type, source_detail)
  SELECT DISTINCT al.record_id::uuid, 'reopened', 'audit_logs.rent_request_reopened'
  FROM public.audit_logs al
  WHERE al.action_type = 'rent_request_reopened'
    AND al.record_id IS NOT NULL
  ON CONFLICT (rent_request_id, restructure_type) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_count := v_count + v_inserted;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_refresh_restructure_register() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_refresh_restructure_register() IS
'Polls rent_repayment_pauses, rent_requests.registration_type=renewal (predecessor inferred, disclosed), and audit_logs.action_type=rent_request_reopened (the only reliable reopen marker) to populate tops_restructure_register. No trigger anywhere — this is the "detect state transitions by snapshotting on our own schedule" approach the brief asked for, since FINDINGS confirms no reopen event has ever fired live and pauses leave no trace in the billing tables. Append-only, idempotent. Internal-only (no EXECUTE grant, including authenticated) — driven by the tops-refresh-restructure-register-hourly cron job.';

SELECT cron.schedule(
  'tops-refresh-restructure-register-hourly',
  '0 * * * *',
  $$ SELECT public.tops_refresh_restructure_register(); $$
);

-- ---------------------------------------------------------------------------
-- 3. tops_portfolio_quality(p_as_at) — PAR@7/14/30, repayment rate at day
--    14/30/at-term by funding month, completion rate, repeat rate.
--
-- PAR denominator/numerator both use GREATEST(total_repayment -
-- amount_repaid, 0) directly from rent_requests — NOT tops_plan_instalments'
-- own outstanding_ugx — because tops_plan_instalments/tops_build_plan_instalments
-- only fires for a plan with a LOCKED cadence (confirmed live: ~5 of 820
-- active plans), so an instalments-only denominator would silently exclude
-- ~99% of the live portfolio. "Days past due" (which plans count as at-risk)
-- still comes from tops_open_instalments_asof, since that is the only
-- existing source for it — so today, PAR@7/14/30's AGE-based numerator only
-- reflects the same small instalment-tracked subset; it will grow as that
-- population does. A plan in tops_restructure_register is added to every
-- PAR numerator regardless of its own age or current status, per the brief.
--
-- Completion rate and repeat rate reuse existing, already-reviewed
-- definitions rather than inventing new ones: completion mirrors
-- TenantProfileView.tsx's own basis (completed ÷ {approved,funded,disbursed,
-- repaying,completed}, simplified here to the plans this cohort query
-- already selects); repeat reuses get_coo_rent_coverage_statement()'s "real
-- plan" test verbatim (status in repaying/funded/completed AND (funded_at
-- is not null OR amount_repaid>0 OR a non-reversed collection exists)) and
-- its ">1 real plan" repeat-tenant rule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_portfolio_quality(p_as_at date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_par jsonb;
  v_cohorts jsonb;
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

  WITH live_plans AS (
    SELECT rr.id AS rent_request_id,
      GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0) AS outstanding_ugx
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'repaying')
  ),
  oldest_due AS (
    SELECT o.rent_request_id, MIN(o.due_date) AS oldest_due_date
    FROM public.tops_open_instalments_asof(v_as_at) o
    WHERE NOT o.never_billed
    GROUP BY o.rent_request_id
  ),
  registered AS (
    SELECT DISTINCT rent_request_id FROM public.tops_restructure_register
  ),
  flagged AS (
    SELECT
      lp.outstanding_ugx,
      ((od.oldest_due_date IS NOT NULL AND (v_as_at - od.oldest_due_date) >= 7) OR reg.rent_request_id IS NOT NULL) AS at_7,
      ((od.oldest_due_date IS NOT NULL AND (v_as_at - od.oldest_due_date) >= 14) OR reg.rent_request_id IS NOT NULL) AS at_14,
      ((od.oldest_due_date IS NOT NULL AND (v_as_at - od.oldest_due_date) >= 30) OR reg.rent_request_id IS NOT NULL) AS at_30
    FROM live_plans lp
    LEFT JOIN oldest_due od ON od.rent_request_id = lp.rent_request_id
    LEFT JOIN registered reg ON reg.rent_request_id = lp.rent_request_id
  )
  SELECT jsonb_build_object(
    'days_7', jsonb_build_object(
      'rate', ROUND(COALESCE(SUM(outstanding_ugx) FILTER (WHERE at_7), 0) / NULLIF(SUM(outstanding_ugx), 0), 4),
      'at_risk_ugx', COALESCE(SUM(outstanding_ugx) FILTER (WHERE at_7), 0)
    ),
    'days_14', jsonb_build_object(
      'rate', ROUND(COALESCE(SUM(outstanding_ugx) FILTER (WHERE at_14), 0) / NULLIF(SUM(outstanding_ugx), 0), 4),
      'at_risk_ugx', COALESCE(SUM(outstanding_ugx) FILTER (WHERE at_14), 0)
    ),
    'days_30', jsonb_build_object(
      'rate', ROUND(COALESCE(SUM(outstanding_ugx) FILTER (WHERE at_30), 0) / NULLIF(SUM(outstanding_ugx), 0), 4),
      'at_risk_ugx', COALESCE(SUM(outstanding_ugx) FILTER (WHERE at_30), 0)
    ),
    'total_outstanding_ugx', COALESCE(SUM(outstanding_ugx), 0)
  ) INTO v_par
  FROM flagged;

  WITH cohort_plans AS (
    SELECT rr.id AS rent_request_id, rr.tenant_id,
      date_trunc('month', rr.funded_at)::date AS funding_month,
      rr.funded_at, rr.duration_days, rr.daily_repayment, rr.total_repayment, rr.amount_repaid, rr.status
    FROM public.rent_requests rr
    WHERE rr.funded_at IS NOT NULL
      AND rr.status IN ('funded', 'repaying', 'completed')
  ),
  expected_14 AS (
    SELECT rent_request_id, LEAST(COALESCE(daily_repayment, 0) * 14, COALESCE(total_repayment, 0)) AS exp_14
    FROM cohort_plans
  ),
  expected_30 AS (
    SELECT rent_request_id, LEAST(COALESCE(daily_repayment, 0) * 30, COALESCE(total_repayment, 0)) AS exp_30
    FROM cohort_plans
  ),
  collected_14 AS (
    SELECT cp.rent_request_id, COALESCE(SUM(ac.amount), 0) AS paid_14
    FROM cohort_plans cp
    LEFT JOIN public.agent_collections ac ON ac.rent_request_id = cp.rent_request_id
      AND ac.reversed_at IS NULL
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= (cp.funded_at AT TIME ZONE 'Africa/Kampala')::date + 14
    GROUP BY cp.rent_request_id
  ),
  collected_30 AS (
    SELECT cp.rent_request_id, COALESCE(SUM(ac.amount), 0) AS paid_30
    FROM cohort_plans cp
    LEFT JOIN public.agent_collections ac ON ac.rent_request_id = cp.rent_request_id
      AND ac.reversed_at IS NULL
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= (cp.funded_at AT TIME ZONE 'Africa/Kampala')::date + 30
    GROUP BY cp.rent_request_id
  ),
  term_elapsed AS (
    SELECT cp.rent_request_id, cp.funding_month, cp.total_repayment, cp.amount_repaid
    FROM cohort_plans cp
    WHERE (cp.funded_at AT TIME ZONE 'Africa/Kampala')::date + COALESCE(cp.duration_days, 0) <= v_as_at
  ),
  real_plans AS (
    SELECT rr.id, rr.tenant_id, date_trunc('month', rr.funded_at)::date AS funding_month
    FROM public.rent_requests rr
    WHERE rr.status IN ('repaying', 'funded', 'completed')
      AND (
        rr.funded_at IS NOT NULL
        OR COALESCE(rr.amount_repaid, 0) > 0
        OR EXISTS (SELECT 1 FROM public.agent_collections ac WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL)
      )
  ),
  tenant_real_plan_counts AS (
    SELECT tenant_id, count(*) AS real_plan_count
    FROM real_plans
    GROUP BY tenant_id
  ),
  cohort_repeat AS (
    SELECT rp.funding_month,
      count(DISTINCT rp.tenant_id) FILTER (WHERE trc.real_plan_count > 1) AS repeat_tenants,
      count(DISTINCT rp.tenant_id) AS cohort_tenants
    FROM real_plans rp
    JOIN tenant_real_plan_counts trc ON trc.tenant_id = rp.tenant_id
    WHERE rp.funding_month IS NOT NULL
    GROUP BY rp.funding_month
  ),
  cohort_completion AS (
    SELECT funding_month,
      count(*) FILTER (WHERE status = 'completed') AS completed_count,
      count(*) AS cohort_plan_count
    FROM cohort_plans
    WHERE funding_month IS NOT NULL
    GROUP BY funding_month
  ),
  cohort_repay AS (
    SELECT cp.funding_month,
      SUM(LEAST(c14.paid_14, e14.exp_14)) AS capped_paid_14,
      SUM(e14.exp_14) AS total_exp_14,
      SUM(LEAST(c30.paid_30, e30.exp_30)) AS capped_paid_30,
      SUM(e30.exp_30) AS total_exp_30
    FROM cohort_plans cp
    LEFT JOIN expected_14 e14 ON e14.rent_request_id = cp.rent_request_id
    LEFT JOIN expected_30 e30 ON e30.rent_request_id = cp.rent_request_id
    LEFT JOIN collected_14 c14 ON c14.rent_request_id = cp.rent_request_id
    LEFT JOIN collected_30 c30 ON c30.rent_request_id = cp.rent_request_id
    WHERE cp.funding_month IS NOT NULL
    GROUP BY cp.funding_month
  ),
  cohort_term AS (
    SELECT funding_month,
      SUM(amount_repaid) AS term_paid,
      SUM(total_repayment) AS term_expected,
      count(*) AS term_plan_count
    FROM term_elapsed
    GROUP BY funding_month
  ),
  months AS (
    SELECT DISTINCT funding_month FROM cohort_plans WHERE funding_month IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'funding_month', m.funding_month,
    'plan_count', cc.cohort_plan_count,
    'repayment_rate_day14', ROUND(cr.capped_paid_14 / NULLIF(cr.total_exp_14, 0), 4),
    'repayment_rate_day30', ROUND(cr.capped_paid_30 / NULLIF(cr.total_exp_30, 0), 4),
    'repayment_rate_at_term', ROUND(ct.term_paid / NULLIF(ct.term_expected, 0), 4),
    'term_elapsed_plan_count', COALESCE(ct.term_plan_count, 0),
    'completion_rate', ROUND(cc.completed_count::numeric / NULLIF(cc.cohort_plan_count, 0), 4),
    'repeat_rate', ROUND(crep.repeat_tenants::numeric / NULLIF(crep.cohort_tenants, 0), 4)
  ) ORDER BY m.funding_month), '[]'::jsonb)
  INTO v_cohorts
  FROM months m
  LEFT JOIN cohort_repay cr ON cr.funding_month = m.funding_month
  LEFT JOIN cohort_term ct ON ct.funding_month = m.funding_month
  LEFT JOIN cohort_completion cc ON cc.funding_month = m.funding_month
  LEFT JOIN cohort_repeat crep ON crep.funding_month = m.funding_month;

  RETURN jsonb_build_object(
    'as_at', v_as_at,
    'par', v_par,
    'by_funding_month', v_cohorts,
    'basis', 'kampala;reversals_excluded;capped_per_plan_day14_day30;register_forces_par_numerator_regardless_of_status;completion_and_repeat_definitions_reused_from_get_coo_rent_coverage_statement'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tops_portfolio_quality(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_portfolio_quality(date) TO authenticated;

COMMENT ON FUNCTION public.tops_portfolio_quality(date) IS
'Portfolio-at-risk (PAR@7/14/30, both rate and UGX, denominator/numerator basis GREATEST(total_repayment-amount_repaid,0) so a plan does not need tops_plan_instalments coverage to count — only its AGE-based numerator does, which is currently a small, growing subset per docs/TOPS_BUILD_LOG.md), repayment rate at day 14/30/at-term by funding month, completion rate, and repeat rate (definitions reused verbatim from get_coo_rent_coverage_statement()/TenantProfileView.tsx precedent, not invented). Every plan in tops_restructure_register counts toward every PAR numerator regardless of its own current age or status. Gated by an internal has_role check.';
