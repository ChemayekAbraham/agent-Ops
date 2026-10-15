-- Agent Ops: the agent network overview for a date range. ONE new read-only function; nothing existing is changed and nothing is written
-- (no wallet, no ledger, no pin: expected collections are READ from agent_expected_day_plans, the command centre's own pins, never created here).
--
--   get_agent_ops_network_overview(p_start date, p_end date, p_min_expected numeric DEFAULT 50000) RETURNS jsonb
--
-- Access: copied from get_agent_ops_overview (a missing user raises 'auth_required'; anything but is_ops_role / manager / cfo / ceo / coo /
-- cto / super_admin raises 'not_authorized'). EXECUTE for authenticated only. SECURITY DEFINER, STABLE, search_path = public.
-- Range: Kampala calendar days, [p_start 00:00, p_end + 1 day 00:00) Africa/Kampala. p_end may not be a future Kampala day (22023), the same rule
-- tops_smartphone_usage applies.
--
-- Definitions (only these):
--   agent set          public.agent_ops_qualifying_agent_ids(), minus deleted accounts; each person once.
--   deleted account    profiles.deleted_at IS NOT NULL, or deleted_accounts.status = 'soft_deleted' and not restored or purged. Deleted people are
--                      left out of every set below (agents, sub-agents, smartphone tenants). A Rent Plan request is not an account, so a request of
--                      a deleted tenant still counts for its (live) agent; none of them is in the live book today.
--   agent on a request COALESCE(assigned_agent_id, agent_id), rows where it equals tenant_id left out.
--   posted             every status. approved = funded / repaying / completed, dated COALESCE(cfo_reviewed_at, funded_at), inside the range.
--   live book          funded / repaying and COALESCE(tenancy_status,'active') <> 'ended'.
--   service centre     active, non-revoked service_center_managers.agent_id, UNION distinct rent_requests.service_center_manager_id, UNION active
--                      service_centre_agent_assignments.agent_id.
--   bikes              agent_bike_leases not rejected and (status = 'approved' or lease_activated_at is not null); sum(amount_outstanding).
--   smartphone plan    merchandise_sales (the table smartphone_repayment_schedules.sale_id points to) with at least one schedule row, not rejected,
--                      owned by customer_id (always the creator today).
--   smartphone tenants tops_smartphone_usage returns platform-wide TENANT totals only (no agent-level figure), so it is returned unchanged as
--                      smartphone_usage. counts.with_smartphone_tenants counts the agents whose tenants are in its "recorded smartphone" group
--                      (the same population: tenant role enabled, not deleted, profiles.has_smartphone).
--   sub-agents         agent_subagents.status = 'verified' with sub_agent_id in the agent set; with_subagents = distinct parents in the agent set.
--   portfolio          sum(greatest(total_repayment - amount_repaid, 0)) over the live book.
--   collection rate    non-reversed agent_collections in the range / sum(agent_expected_day_plans.expected_ugx) for the range's Kampala days up to
--                      today (the command centre's pinned basis). Only agents whose expected is at least p_min_expected are ranked.
--   default rate       defaulted outstanding / outstanding over the live book. Defaulted = the plan's arrears on the payout clock
--                      (_am_plan_arrears_core as at today, the clock the tenant classification is built on), never more than its outstanding.
--                      Ascending, only agents whose outstanding is at least p_min_expected.
--   receivables        v_receivables_lines rows with product_key 'rent_plan' (source rent_requests) whose item_id is one of the approved requests.
--
-- counts are all-time snapshots; approved, the collection rate and smartphone_usage follow the range. Amounts are UGX whole numbers.
-- Rollback: supabase/rollbacks/20261015200000_agent_ops_network_overview.rollback.sql

CREATE OR REPLACE FUNCTION public.get_agent_ops_network_overview(
  p_start date,
  p_end date,
  p_min_expected numeric DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_min numeric := GREATEST(COALESCE(p_min_expected, 50000), 0);
  v_phone jsonb;
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cto')
    OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_start IS NULL OR p_end IS NULL THEN
    RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_end < p_start THEN
    RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023';
  END IF;
  IF p_end > v_today THEN
    RAISE EXCEPTION 'RANGE_FUTURE: p_end is a future Kampala day' USING ERRCODE = '22023';
  END IF;

  v_start := p_start::timestamp AT TIME ZONE 'Africa/Kampala';
  v_end := (p_end + 1)::timestamp AT TIME ZONE 'Africa/Kampala';

  -- the tenant smartphone figures, exactly as that function decides them (same range, Kampala days)
  v_phone := public.tops_smartphone_usage(p_start, p_end);

  WITH
  gone AS MATERIALIZED (
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION
    SELECT d.user_id FROM public.deleted_accounts d
     WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL
  ),
  ag AS MATERIALIZED (
    SELECT DISTINCT q.agent_id AS id
      FROM public.agent_ops_qualifying_agent_ids() q
     WHERE q.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = q.agent_id)
  ),
  rr AS MATERIALIZED (
    SELECT r.id, COALESCE(r.assigned_agent_id, r.agent_id) AS aid, r.tenant_id, r.status, r.rent_amount, r.total_repayment, r.amount_repaid,
           r.tenancy_status, COALESCE(r.cfo_reviewed_at, r.funded_at) AS approved_at
      FROM public.rent_requests r
     WHERE COALESCE(r.assigned_agent_id, r.agent_id) IS NOT NULL
       AND COALESCE(r.assigned_agent_id, r.agent_id) <> r.tenant_id
       AND COALESCE(r.assigned_agent_id, r.agent_id) IN (SELECT id FROM ag)
  ),
  posted AS (SELECT DISTINCT aid FROM rr),
  appr_ever AS (SELECT DISTINCT aid FROM rr WHERE status IN ('funded', 'repaying', 'completed')),
  appr_rng AS (
    SELECT * FROM rr
     WHERE status IN ('funded', 'repaying', 'completed') AND approved_at >= v_start AND approved_at < v_end
  ),
  live AS MATERIALIZED (
    SELECT id, aid, GREATEST(COALESCE(total_repayment, 0) - COALESCE(amount_repaid, 0), 0) AS outstanding
      FROM rr
     WHERE status IN ('funded', 'repaying') AND COALESCE(tenancy_status, 'active') <> 'ended'
  ),
  arr AS (
    SELECT a.rent_request_id, GREATEST(a.arrears, 0) AS arrears
      FROM public._am_plan_arrears_core((SELECT array_agg(id) FROM live), v_today) a
  ),
  book AS (
    SELECT l.aid,
           sum(l.outstanding) AS outstanding,
           count(*) AS plans,
           sum(LEAST(COALESCE(arr.arrears, 0), l.outstanding)) AS defaulted
      FROM live l
      LEFT JOIN arr ON arr.rent_request_id = l.id
     GROUP BY l.aid
  ),
  sc AS (
    SELECT m.agent_id AS id FROM public.service_center_managers m
     WHERE m.status = 'active' AND m.revoked_at IS NULL AND m.agent_id IN (SELECT id FROM ag)
    UNION
    SELECT r.service_center_manager_id FROM public.rent_requests r
     WHERE r.service_center_manager_id IN (SELECT id FROM ag)
    UNION
    SELECT a.agent_id FROM public.service_centre_agent_assignments a
     WHERE a.status = 'active' AND a.unassigned_at IS NULL AND a.agent_id IN (SELECT id FROM ag)
  ),
  bikes AS (
    SELECT b.agent_id AS aid, COALESCE(b.amount_outstanding, 0) AS outstanding
      FROM public.agent_bike_leases b
     WHERE b.status <> 'rejected' AND (b.status = 'approved' OR b.lease_activated_at IS NOT NULL)
       AND b.agent_id IN (SELECT id FROM ag)
  ),
  phone_plan AS (
    SELECT DISTINCT s.customer_id AS id
      FROM public.merchandise_sales s
     WHERE EXISTS (SELECT 1 FROM public.smartphone_repayment_schedules x WHERE x.sale_id = s.id)
       AND COALESCE(s.order_status, '') <> 'rejected'
       AND s.customer_id IN (SELECT id FROM ag)
  ),
  phone_tenants AS (
    SELECT DISTINCT r.aid AS id
      FROM rr r
      JOIN public.profiles p ON p.id = r.tenant_id
     WHERE p.has_smartphone IS TRUE
       AND NOT EXISTS (SELECT 1 FROM gone g WHERE g.id = p.id)
       AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role::text = 'tenant' AND ur.enabled)
  ),
  subs AS (
    SELECT s.parent_agent_id, s.sub_agent_id
      FROM public.agent_subagents s
     WHERE s.status = 'verified' AND s.sub_agent_id IN (SELECT id FROM ag) AND s.parent_agent_id IN (SELECT id FROM ag)
  ),
  col AS (
    SELECT ac.agent_id AS aid, COALESCE(sum(ac.amount), 0) AS collected
      FROM public.agent_collections ac
     WHERE ac.reversed_at IS NULL AND ac.created_at >= v_start AND ac.created_at < v_end AND ac.agent_id IN (SELECT id FROM ag)
     GROUP BY ac.agent_id
  ),
  expd AS (
    SELECT p.agent_id AS aid, COALESCE(sum(p.expected_ugx), 0) AS expected
      FROM public.agent_expected_day_plans p
     WHERE p.day BETWEEN p_start AND LEAST(p_end, v_today) AND p.agent_id IN (SELECT id FROM ag)
     GROUP BY p.agent_id
  ),
  rate AS (
    SELECT e.aid, e.expected, COALESCE(c.collected, 0) AS collected,
           round(100.0 * COALESCE(c.collected, 0) / e.expected, 1) AS rate_pct
      FROM expd e LEFT JOIN col c ON c.aid = e.aid
     WHERE e.expected >= v_min AND e.expected > 0
  ),
  drate AS (
    SELECT b.aid, b.outstanding, b.defaulted, b.plans,
           round(100.0 * b.defaulted / b.outstanding, 1) AS default_rate_pct
      FROM book b
     WHERE b.outstanding >= v_min AND b.outstanding > 0
  ),
  recv AS (
    SELECT COALESCE(sum(v.outstanding_amount), 0) AS amt
      FROM public.v_receivables_lines v
     WHERE v.product_key = 'rent_plan' AND v.source_table = 'rent_requests' AND v.item_id IN (SELECT id FROM appr_rng)
  ),
  pro AS (SELECT id, full_name, phone FROM public.profiles WHERE id IN (SELECT id FROM ag))
  SELECT jsonb_build_object(
    'range', jsonb_build_object(
      'start', p_start, 'end', p_end, 'from_ts', v_start, 'to_ts', v_end, 'as_at', v_today, 'min_expected', round(v_min)::bigint,
      'days_without_pin', (SELECT count(*) FROM generate_series(p_start, LEAST(p_end, v_today), interval '1 day') g(d)
                            WHERE NOT EXISTS (SELECT 1 FROM public.agent_expected_day_plans p WHERE p.day = g.d::date))
    ),
    'counts', jsonb_build_object(
      'agents', (SELECT count(*) FROM ag),
      'with_service_centres', (SELECT count(*) FROM sc),
      'with_bikes', (SELECT count(DISTINCT aid) FROM bikes),
      'with_smartphone_plan', (SELECT count(*) FROM phone_plan),
      'with_smartphone_tenants', (SELECT count(*) FROM phone_tenants),
      'with_subagents', (SELECT count(DISTINCT parent_agent_id) FROM subs),
      'posted_requests', (SELECT count(*) FROM posted),
      'approved_agents', (SELECT count(*) FROM appr_ever)
    ),
    'approved', jsonb_build_object(
      'agents', (SELECT count(DISTINCT aid) FROM appr_rng),
      'requests', (SELECT count(*) FROM appr_rng),
      'amount', (SELECT round(COALESCE(sum(rent_amount), 0))::bigint FROM appr_rng),
      'receivables_outstanding', (SELECT round(amt)::bigint FROM recv)
    ),
    'live_book', jsonb_build_object(
      'agents', (SELECT count(*) FROM book),
      'plans', (SELECT COALESCE(sum(plans), 0) FROM book),
      'outstanding', (SELECT round(COALESCE(sum(outstanding), 0))::bigint FROM book),
      'defaulted', (SELECT round(COALESCE(sum(defaulted), 0))::bigint FROM book)
    ),
    'bikes', jsonb_build_object(
      'agents', (SELECT count(DISTINCT aid) FROM bikes),
      'leases', (SELECT count(*) FROM bikes),
      'amount_outstanding', (SELECT round(COALESCE(sum(outstanding), 0))::bigint FROM bikes)
    ),
    'smartphone_usage', v_phone,
    'top_portfolios', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('agent_id', t.aid, 'name', COALESCE(p.full_name, 'Unnamed agent'), 'phone', p.phone,
                                          'portfolio', round(t.outstanding)::bigint, 'plans', t.plans) ORDER BY t.outstanding DESC, t.aid)
        FROM (SELECT * FROM book ORDER BY outstanding DESC, aid LIMIT 10) t LEFT JOIN pro p ON p.id = t.aid), '[]'::jsonb),
    'top_collection_rate', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('agent_id', t.aid, 'name', COALESCE(p.full_name, 'Unnamed agent'), 'phone', p.phone,
                                          'collected', round(t.collected)::bigint, 'expected', round(t.expected)::bigint, 'rate_pct', t.rate_pct)
                       ORDER BY t.rate_pct DESC, t.collected DESC, t.aid)
        FROM (SELECT * FROM rate ORDER BY rate_pct DESC, collected DESC, aid LIMIT 10) t LEFT JOIN pro p ON p.id = t.aid), '[]'::jsonb),
    'default_rate_ascending', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('agent_id', t.aid, 'name', COALESCE(p.full_name, 'Unnamed agent'), 'phone', p.phone,
                                          'outstanding', round(t.outstanding)::bigint, 'defaulted', round(t.defaulted)::bigint,
                                          'default_rate_pct', t.default_rate_pct, 'plans', t.plans)
                       ORDER BY t.default_rate_pct ASC, t.outstanding DESC, t.aid)
        FROM (SELECT * FROM drate ORDER BY default_rate_pct ASC, outstanding DESC, aid LIMIT 10) t LEFT JOIN pro p ON p.id = t.aid), '[]'::jsonb),
    'generated_at', now()
  )
  INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.get_agent_ops_network_overview(date, date, numeric) IS
  'Read-only Agent Ops network overview for Kampala days p_start..p_end: agent counts (service centres, bikes, smartphones, sub-agents), approved Rent Plan requests in range with their receivables, top portfolios, top collection rate and lowest default rate (agents under p_min_expected are not ranked). Same role check as get_agent_ops_overview.';

REVOKE ALL ON FUNCTION public.get_agent_ops_network_overview(date, date, numeric) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_network_overview(date, date, numeric) TO authenticated;
