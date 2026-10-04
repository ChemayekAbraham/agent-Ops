-- Agent Operations reports: score agents on money against the window's bill,
-- not on all cash received.
--
-- The problem
-- -----------
-- 20260908220000 fixed the *expected* side of these reports by moving it onto
-- the pinned schedule. The *collected* side was left as SUM(agent_collections.
-- amount) over the window, with no check that the plan was ever billed in that
-- window. Tenants clear older bills every day, so the numerator contains money
-- the denominator never billed:
--
--   2026-09-08, single day:
--     expected (pinned)                     3,673,184
--     all cash received                     3,427,483   -> 93%  "rate"
--     of which against that day's bill      1,534,261   -> 41.8% real coverage
--     of which arrears on older bills       1,893,222
--
-- That header's own worked example (2026-09-01..08, rate 59.7%) is the same
-- inflation over a week. Because the status ladder reads `rate`
-- (Excellent >=100, On track >=75, Fair >=50, Behind <50), agents were being
-- graded on a figure that counts old debt as this window's performance — the
-- mirror image of the eligibility bug that graded them too harshly.
--
-- The change
-- ----------
-- New helper `agent_ops_report_collected(p_from, p_to)` splits each agent's
-- cash three ways, mirroring get_agent_collections_coverage so the reports and
-- the Collections Command Center cannot drift apart:
--
--   collected_on_schedule   plan was billed on some day in the window
--   collected_arrears       plan carries an id but this window never billed it
--   collected_unattributed  token/QR collections, which carry no plan id at all
--                           (975 of the last 10,828 rows) and so can be neither
--                           matched nor fairly called arrears
--
-- `rate` and every ranking now use collected_on_schedule. `collected` keeps
-- meaning total cash so nothing downstream that reads it silently changes, and
-- the split is exposed alongside it — arrears are real money and belong on the
-- report as their own line, not hidden inside a percentage.
--
-- A payment counts as on-schedule when its plan was billed on ANY elapsed day
-- in the window, not day-for-day: a tenant billed Monday who pays Wednesday has
-- still paid a bill the window owns.
--
-- `status` still reads total collected for 'Silent', because an agent who
-- cleared only arrears did work — they just scored nothing against this
-- window's bill, which the rate now says plainly.
--
-- Signature, LANGUAGE, volatility, SECURITY DEFINER and search_path unchanged
-- on both rewritten functions. Read-only, no ledger path.

create or replace function public.agent_ops_report_collected(p_from date, p_to date)
returns table(
  agent_id uuid,
  collected numeric,
  collected_on_schedule numeric,
  collected_arrears numeric,
  collected_unattributed numeric,
  payments integer,
  paid_tenants integer
)
language sql
stable
security definer
set search_path = public
as $$
  WITH bill AS (
    SELECT DISTINCT p.rent_request_id
    FROM public.agent_expected_day_plans p
    WHERE p.day BETWEEN p_from AND p_to
  )
  SELECT ac.agent_id,
         COALESCE(SUM(ac.amount), 0)::numeric AS collected,
         COALESCE(SUM(ac.amount) FILTER (
           WHERE EXISTS (SELECT 1 FROM bill b WHERE b.rent_request_id = ac.rent_request_id)
         ), 0)::numeric AS collected_on_schedule,
         COALESCE(SUM(ac.amount) FILTER (
           WHERE ac.rent_request_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM bill b WHERE b.rent_request_id = ac.rent_request_id)
         ), 0)::numeric AS collected_arrears,
         COALESCE(SUM(ac.amount) FILTER (WHERE ac.rent_request_id IS NULL), 0)::numeric
           AS collected_unattributed,
         COUNT(*)::int AS payments,
         COUNT(DISTINCT COALESCE(ac.rent_request_id, ac.tenant_id))::int AS paid_tenants
  FROM public.agent_collections ac
  WHERE ac.amount > 0
    AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    AND ac.agent_id IS NOT NULL
  GROUP BY ac.agent_id;
$$;

comment on function public.agent_ops_report_collected(date, date) is
  'Per-agent collections in a window split into money against that window''s pinned bill, arrears on older bills, and unattributed token collections. Companion to agent_ops_report_expected; keeps report rates off the inflated all-cash numerator.';

revoke all on function public.agent_ops_report_collected(date, date) from public;
grant execute on function public.agent_ops_report_collected(date, date) to authenticated;

create or replace function public.agent_ops_report_rent_collections(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
DECLARE v_rows jsonb; v_sum record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  WITH exp AS (
    SELECT e.agent_id, e.expected, e.tenants FROM public.agent_ops_report_expected(p_from, p_to) e
  ), got AS (
    SELECT c.agent_id, c.collected, c.collected_on_schedule,
           c.collected_arrears + c.collected_unattributed AS collected_arrears,
           c.payments, c.paid_tenants
    FROM public.agent_ops_report_collected(p_from, p_to) c
  ), merged AS (
    SELECT COALESCE(e.agent_id, g.agent_id) AS agent_id,
           COALESCE(e.expected,0) AS expected,
           COALESCE(e.tenants,0) AS repaying_tenants,
           COALESCE(g.collected,0) AS collected,
           COALESCE(g.collected_on_schedule,0) AS collected_on_schedule,
           COALESCE(g.collected_arrears,0) AS collected_arrears,
           COALESCE(g.payments,0) AS payments,
           COALESCE(g.paid_tenants,0) AS paid_tenants
    FROM exp e FULL OUTER JOIN got g ON g.agent_id = e.agent_id
    WHERE COALESCE(e.agent_id, g.agent_id) IS NOT NULL
  ), scored AS (
    SELECT m.*, p.full_name, p.phone,
           CASE WHEN m.expected > 0
                THEN ROUND(m.collected_on_schedule*100.0/m.expected,1) END AS rate
    FROM merged m LEFT JOIN public.profiles p ON p.id = m.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', s.agent_id,
           'full_name', s.full_name,
           'phone', s.phone,
           'repaying_tenants', s.repaying_tenants,
           'expected', s.expected,
           'collected', s.collected,
           'collected_on_schedule', s.collected_on_schedule,
           'collected_arrears', s.collected_arrears,
           'payments', s.payments,
           'paid_tenants', s.paid_tenants,
           'rate', s.rate,
           'rate_basis', 'on_schedule_uncapped',
           'status', CASE
             WHEN s.collected <= 0 THEN 'Silent'
             WHEN s.rate IS NULL THEN 'Unscheduled'
             WHEN s.rate >= 100 THEN 'Excellent'
             WHEN s.rate >= 75 THEN 'On track'
             WHEN s.rate >= 50 THEN 'Fair'
             ELSE 'Behind' END
         ) ORDER BY s.collected DESC NULLS LAST), '[]'::jsonb)
    INTO v_rows
  FROM scored s;

  SELECT
    (SELECT COUNT(*) FROM public.agent_ops_report_expected(p_from, p_to)) AS total_agents,
    (SELECT COUNT(*) FROM public.agent_ops_report_collected(p_from, p_to)) AS active_agents,
    (SELECT COALESCE(SUM(e.expected),0) FROM public.agent_ops_report_expected(p_from, p_to) e) AS expected,
    (SELECT COALESCE(SUM(c.collected),0) FROM public.agent_ops_report_collected(p_from, p_to) c) AS collected,
    (SELECT COALESCE(SUM(c.collected_on_schedule),0) FROM public.agent_ops_report_collected(p_from, p_to) c) AS collected_on_schedule,
    (SELECT COALESCE(SUM(c.collected_arrears + c.collected_unattributed),0) FROM public.agent_ops_report_collected(p_from, p_to) c) AS collected_arrears,
    (SELECT COALESCE(SUM(e.tenants),0) FROM public.agent_ops_report_expected(p_from, p_to) e) AS repaying_tenants
  INTO v_sum;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'total_agents', v_sum.total_agents,
      'active_agents', v_sum.active_agents,
      'expected', v_sum.expected,
      'collected', v_sum.collected,
      'collected_on_schedule', v_sum.collected_on_schedule,
      'collected_arrears', v_sum.collected_arrears,
      'repaying_tenants', v_sum.repaying_tenants,
      'collection_rate', CASE WHEN v_sum.expected > 0
                              THEN ROUND(v_sum.collected_on_schedule*100.0/v_sum.expected,1) END,
      'rate_basis', 'on_schedule_uncapped'
    ),
    'rows', v_rows
  );
END;
$$;

create or replace function public.agent_ops_report_team_collections(
  p_parent_agent_id uuid, p_from date, p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
DECLARE v_leader jsonb; v_rows jsonb; v_sum record; v_rank record;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_parent_agent_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  SELECT jsonb_build_object('parent_agent_id', p.id, 'full_name', p.full_name, 'phone', p.phone)
    INTO v_leader FROM public.profiles p WHERE p.id = p_parent_agent_id;

  WITH members AS (
    SELECT DISTINCT h.member_agent_id AS agent_id
    FROM public.agent_team_membership_history h
    WHERE h.parent_agent_id = p_parent_agent_id
      AND h.valid_from::date <= p_to
      AND (h.valid_to IS NULL OR h.valid_to::date >= p_from)
    UNION
    SELECT p_parent_agent_id
  ), exp AS (
    SELECT e.agent_id, e.expected, e.tenants
    FROM public.agent_ops_report_expected(p_from, p_to) e
    WHERE e.agent_id IN (SELECT agent_id FROM members)
  ), got AS (
    SELECT c.agent_id, c.collected, c.collected_on_schedule,
           c.collected_arrears + c.collected_unattributed AS collected_arrears,
           c.payments
    FROM public.agent_ops_report_collected(p_from, p_to) c
    WHERE c.agent_id IN (SELECT agent_id FROM members)
  ), last_seen AS (
    SELECT ac.agent_id, MAX(ac.created_at) AS last_at
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.agent_id IN (SELECT agent_id FROM members)
    GROUP BY ac.agent_id
  ), joined AS (
    SELECT m.agent_id, p.full_name, p.phone,
           COALESCE(e.expected,0) AS expected, COALESCE(e.tenants,0) AS tenants,
           COALESCE(g.collected,0) AS collected,
           COALESCE(g.collected_on_schedule,0) AS collected_on_schedule,
           COALESCE(g.collected_arrears,0) AS collected_arrears,
           COALESCE(g.payments,0) AS payments, l.last_at,
           (m.agent_id = p_parent_agent_id) AS is_leader
    FROM members m
    LEFT JOIN public.profiles p ON p.id = m.agent_id
    LEFT JOIN exp e ON e.agent_id = m.agent_id
    LEFT JOIN got g ON g.agent_id = m.agent_id
    LEFT JOIN last_seen l ON l.agent_id = m.agent_id
  ), tot AS (SELECT SUM(collected) c, SUM(collected_on_schedule) cs, SUM(expected) x FROM joined)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', j.agent_id,
           'full_name', j.full_name,
           'phone', j.phone,
           'is_leader', j.is_leader,
           'tenants', j.tenants,
           'expected', j.expected,
           'collected', j.collected,
           'collected_on_schedule', j.collected_on_schedule,
           'collected_arrears', j.collected_arrears,
           'payments', j.payments,
           'last_collection_at', j.last_at,
           'rate', CASE WHEN j.expected > 0
                        THEN ROUND(j.collected_on_schedule*100.0/j.expected,1) END,
           'rate_basis', 'on_schedule_uncapped',
           -- Share of the team's cash: total collected on purpose, this is a
           -- contribution split rather than attainment.
           'group_share', CASE WHEN (SELECT c FROM tot) > 0
                               THEN ROUND(j.collected*100.0/(SELECT c FROM tot),1) END,
           'share_of_group_expected', CASE WHEN (SELECT x FROM tot) > 0
                               THEN ROUND(j.collected_on_schedule*100.0/(SELECT x FROM tot),1) END
         ) ORDER BY j.collected DESC), '[]'::jsonb)
    INTO v_rows
  FROM joined j;

  SELECT
    (SELECT COUNT(*) FROM (
        SELECT DISTINCT h.member_agent_id FROM public.agent_team_membership_history h
        WHERE h.parent_agent_id = p_parent_agent_id
          AND h.valid_from::date <= p_to AND (h.valid_to IS NULL OR h.valid_to::date >= p_from)
          AND h.member_agent_id <> p_parent_agent_id) s) AS sub_agents,
    COALESCE((SELECT SUM((r->>'collected')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS collected,
    COALESCE((SELECT SUM((r->>'collected_on_schedule')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS collected_on_schedule,
    COALESCE((SELECT SUM((r->>'collected_arrears')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS collected_arrears,
    COALESCE((SELECT SUM((r->>'expected')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS expected,
    COALESCE((SELECT SUM((r->>'tenants')::numeric) FROM jsonb_array_elements(v_rows) r),0) AS tenants
  INTO v_sum;

  WITH all_teams AS (
    SELECT h.parent_agent_id, h.member_agent_id
    FROM public.agent_team_membership_history h
    WHERE h.valid_from::date <= p_to AND (h.valid_to IS NULL OR h.valid_to::date >= p_from)
  ), team_agents AS (
    SELECT parent_agent_id, member_agent_id AS agent_id FROM all_teams
    UNION SELECT DISTINCT parent_agent_id, parent_agent_id FROM all_teams
  ), ex AS (SELECT * FROM public.agent_ops_report_expected(p_from, p_to)),
  gt AS (SELECT * FROM public.agent_ops_report_collected(p_from, p_to)),
  agg AS (
    SELECT ta.parent_agent_id,
           COALESCE(SUM(ex.expected),0) AS expected,
           COALESCE(SUM(gt.collected_on_schedule),0) AS collected
    FROM team_agents ta
    LEFT JOIN ex ON ex.agent_id = ta.agent_id
    LEFT JOIN gt ON gt.agent_id = ta.agent_id
    GROUP BY ta.parent_agent_id
  ), ranked AS (
    SELECT parent_agent_id,
           COUNT(*) FILTER (WHERE TRUE) OVER () AS total_teams,
           RANK() OVER (ORDER BY CASE WHEN expected > 0 THEN collected/expected ELSE -1 END DESC) AS rnk
    FROM agg
  )
  SELECT rnk, total_teams INTO v_rank FROM ranked WHERE parent_agent_id = p_parent_agent_id;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'leader', COALESCE(v_leader,'{}'::jsonb),
    'kpis', jsonb_build_object(
      'sub_agents', v_sum.sub_agents,
      'collected', v_sum.collected,
      'collected_on_schedule', v_sum.collected_on_schedule,
      'collected_arrears', v_sum.collected_arrears,
      'expected', v_sum.expected,
      'tenants', v_sum.tenants,
      'rate', CASE WHEN v_sum.expected > 0
                   THEN ROUND(v_sum.collected_on_schedule*100.0/v_sum.expected,1) END,
      'rate_basis', 'on_schedule_uncapped',
      'rank', v_rank.rnk,
      'total_teams', v_rank.total_teams
    ),
    'rows', v_rows
  );
END;
$$;
