-- Tenant Payment Behavior: breakdowns by agent, place, rent level, plan frequency and plan start
-- cohort, plus the filter options. Additive, read-only.
--
-- tops_payment_behaviour_by(p_start, p_end, p_dimension, ...) one row per key of the chosen
--   dimension ('agent' | 'region' | 'district' | 'rent_band' | 'cadence' | 'cohort'), every
--   figure computed in SQL from tops_pay_behaviour_plans (so the totals reconcile with the summary):
--     paying_tenants, self_payers (and %), self_only / agent_only / mixed tenants, self and agent
--     UGX with the self share, billed and covered UGX with coverage, and the coverage of the
--     self payers versus the agent-only tenants inside that key.
--   A tenant is counted once per key. Agent and place are those of the Rent Plan; rent bands are
--   <150k, 150-300k, 300-500k, 500k-1M, 1M+ (UGX rent amount); cohort is the plan start month.
-- tops_payment_behaviour_options() the agents, regions, districts and plan frequencies a filter can
--   offer, independent of any filter already applied.

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_by(
  p_start timestamptz,
  p_end timestamptz,
  p_dimension text,
  p_agent_id uuid DEFAULT NULL,
  p_region text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_cadence text DEFAULT NULL,
  p_limit int DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 300), 1), 1000);
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_dimension IS NULL OR p_dimension NOT IN ('agent', 'region', 'district', 'rent_band', 'cadence', 'cohort') THEN
    RAISE EXCEPTION 'invalid dimension: %, expected agent/region/district/rent_band/cadence/cohort', p_dimension;
  END IF;

  WITH pl AS MATERIALIZED (
    SELECT * FROM public.tops_pay_behaviour_plans(p_start, p_end, p_agent_id, p_region, p_district, p_cadence)
  ),
  keyed AS (
    SELECT
      CASE p_dimension
        WHEN 'agent' THEN COALESCE(l.pl_agent::text, 'none')
        WHEN 'region' THEN COALESCE(tb.region, 'Unmapped')
        WHEN 'district' THEN COALESCE(tb.district_name, 'Unmapped')
        WHEN 'rent_band' THEN
          CASE WHEN l.pl_rent IS NULL THEN 'unknown' WHEN l.pl_rent < 150000 THEN 'a_lt_150k' WHEN l.pl_rent < 300000 THEN 'b_150_300k'
               WHEN l.pl_rent < 500000 THEN 'c_300_500k' WHEN l.pl_rent < 1000000 THEN 'd_500k_1m' ELSE 'e_1m_plus' END
        WHEN 'cadence' THEN COALESCE(l.pl_cadence, 'unknown')
        WHEN 'cohort' THEN COALESCE(to_char(l.pl_start, 'YYYY-MM'), 'unknown')
      END AS k,
      l.*
    FROM pl l
    LEFT JOIN public.v_tlb_tenant_base tb ON p_dimension IN ('region', 'district') AND tb.tenant_id = l.pl_tenant
  ),
  agg AS (
    SELECT
      x.k,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_paid_ugx > 0)::int AS paying,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_billed_ugx > 0)::int AS billed_tenants,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_self_n > 0)::int AS self_payers,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_segment = 'self_only')::int AS self_only,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_segment = 'agent_only')::int AS agent_only,
      count(DISTINCT x.pl_tenant) FILTER (WHERE x.pl_segment = 'mixed')::int AS mixed,
      count(*)::int AS plans,
      SUM(x.pl_self_ugx) AS self_ugx, SUM(x.pl_agent_ugx) AS agent_ugx, SUM(x.pl_other_ugx) AS other_ugx,
      SUM(x.pl_billed_ugx) AS billed, SUM(x.pl_covered_ugx) AS covered,
      SUM(x.pl_billed_ugx) FILTER (WHERE x.pl_self_n > 0) AS self_billed,
      SUM(x.pl_covered_ugx) FILTER (WHERE x.pl_self_n > 0) AS self_covered,
      SUM(x.pl_billed_ugx) FILTER (WHERE x.pl_segment = 'agent_only') AS ag_billed,
      SUM(x.pl_covered_ugx) FILTER (WHERE x.pl_segment = 'agent_only') AS ag_covered
    FROM keyed x GROUP BY x.k
  ),
  labelled AS (
    SELECT a.*,
      CASE p_dimension
        WHEN 'agent' THEN COALESCE(NULLIF(trim(pr.full_name), ''), CASE WHEN a.k = 'none' THEN 'No agent' ELSE 'Unnamed agent' END)
        WHEN 'rent_band' THEN CASE a.k WHEN 'a_lt_150k' THEN 'Under UGX 150,000' WHEN 'b_150_300k' THEN 'UGX 150,000 - 300,000'
                WHEN 'c_300_500k' THEN 'UGX 300,000 - 500,000' WHEN 'd_500k_1m' THEN 'UGX 500,000 - 1,000,000'
                WHEN 'e_1m_plus' THEN 'UGX 1,000,000 and above' ELSE 'Unknown rent' END
        WHEN 'cadence' THEN CASE a.k WHEN 'daily' THEN 'Daily' WHEN 'weekly' THEN 'Weekly' WHEN 'monthly' THEN 'Monthly' ELSE initcap(a.k) END
        WHEN 'cohort' THEN CASE WHEN a.k = 'unknown' THEN 'Unknown start' ELSE to_char(to_date(a.k || '-01', 'YYYY-MM-DD'), 'Mon YYYY') END
        ELSE a.k
      END AS label
    FROM agg a
    LEFT JOIN public.profiles pr ON p_dimension = 'agent' AND a.k <> 'none' AND pr.id::text = a.k
    WHERE a.billed > 0 OR a.paying > 0
  )
  SELECT jsonb_build_object(
    'dimension', p_dimension,
    'rows', COALESCE((SELECT jsonb_agg(r.j ORDER BY CASE WHEN p_dimension IN ('rent_band', 'cohort', 'cadence') THEN r.k END ASC, r.paying DESC, r.k) FROM (
      SELECT l.k, l.paying, jsonb_build_object(
        'key', l.k, 'label', l.label, 'plans', l.plans, 'billed_tenants', l.billed_tenants, 'paying_tenants', l.paying,
        'self_payers', l.self_payers, 'self_payers_pct', round(l.self_payers::numeric / NULLIF(l.paying, 0) * 100, 1),
        'self_only', l.self_only, 'agent_only', l.agent_only, 'mixed', l.mixed,
        'self_ugx', l.self_ugx, 'agent_ugx', l.agent_ugx,
        'self_share_pct', round(l.self_ugx / NULLIF(l.self_ugx + l.agent_ugx + l.other_ugx, 0) * 100, 1),
        'billed_ugx', l.billed, 'covered_ugx', l.covered, 'short_ugx', l.billed - l.covered,
        'coverage_pct', round(l.covered / NULLIF(l.billed, 0) * 100, 1),
        'self_payers_coverage_pct', round(l.self_covered / NULLIF(l.self_billed, 0) * 100, 1),
        'agent_only_coverage_pct', round(l.ag_covered / NULLIF(l.ag_billed, 0) * 100, 1)
      ) AS j
      FROM labelled l
      ORDER BY l.paying DESC, l.k
      LIMIT v_limit) r), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_by(timestamptz, timestamptz, text, uuid, text, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_by(timestamptz, timestamptz, text, uuid, text, text, text, int) TO authenticated;

-- ─── tops_payment_behaviour_options ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tops_payment_behaviour_options()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  WITH live AS (
    SELECT rr.id, rr.tenant_id, rr.agent_id, rr.repayment_frequency
    FROM public.rent_requests rr
    WHERE rr.tenant_id IS NOT NULL AND rr.status IN ('repaying', 'funded', 'completed')
  ),
  ag AS (
    SELECT DISTINCT l.agent_id AS id FROM live l WHERE l.agent_id IS NOT NULL
  ),
  loc AS (
    SELECT DISTINCT tb.region, tb.district_name
    FROM live l JOIN public.v_tlb_tenant_base tb ON tb.tenant_id = l.tenant_id
    WHERE tb.region IS NOT NULL
  )
  SELECT jsonb_build_object(
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', COALESCE(NULLIF(trim(pr.full_name), ''), 'Unnamed agent')) ORDER BY COALESCE(NULLIF(trim(pr.full_name), ''), 'zzz'))
                        FROM ag a LEFT JOIN public.profiles pr ON pr.id = a.id), '[]'::jsonb),
    'regions', COALESCE((SELECT jsonb_agg(DISTINCT x.region ORDER BY x.region) FROM loc x), '[]'::jsonb),
    'districts', COALESCE((SELECT jsonb_agg(jsonb_build_object('region', x.region, 'district', x.district_name) ORDER BY x.region, x.district_name)
                           FROM loc x WHERE x.district_name IS NOT NULL), '[]'::jsonb),
    'cadences', COALESCE((SELECT jsonb_agg(DISTINCT l.repayment_frequency ORDER BY l.repayment_frequency) FROM live l WHERE l.repayment_frequency IS NOT NULL), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.tops_payment_behaviour_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_payment_behaviour_options() TO authenticated;
