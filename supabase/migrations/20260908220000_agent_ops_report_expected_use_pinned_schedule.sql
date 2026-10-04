-- Agent Operations reports: base "expected" on the pinned daily schedule, so the
-- reports tally with the Agent Operations dashboard.
--
-- The problem
-- -----------
-- Two unrelated definitions of "expected" were live at once:
--
--   * Agent Operations Overview -> "Pending Collections" tile reads
--     get_agent_collections_command_center(...).totals.expected_due, i.e. the
--     PINNED SCHEDULE in `agent_expected_day_plans` — the instalment actually
--     scheduled for that day.
--   * agent_ops_report_expected read DAILY ELIGIBILITY
--     (agent_daily_eligibility_history / v_agent_daily_eligibility) — who the
--     daily collection gate considers liable.
--
-- Measured 2026-09-01..2026-09-08:
--
--   basis          agents   expected        collected      rate
--   pinned             53   33,014,691      19,710,993     59.7%
--   eligibility       161  116,209,159      19,710,993     17.0%
--
-- Eligibility is 3.52x the pinned schedule, so every report rate came out ~3.5x
-- worse than reality. Against the server's own status ladder (Excellent >=100,
-- On track >=75, Fair >=50, Behind <50) that pushed almost every agent into
-- "Behind" — the wall of red badges seen in Rent Collections.
--
-- For 2026-09-08 the pinned basis gives 3,673,184, which matches the dashboard
-- tile ("UGX 3.67M expected today") exactly.
--
-- The change
-- ----------
-- Read `agent_expected_day_plans` and nothing else. Expected is now "what the
-- rent plan schedule actually says is due", the same figure Agent Operations
-- shows, rather than a gate-eligibility population count.
--
--   expected = SUM(expected_ugx) over the window, per agent
--   tenants  = COUNT(DISTINCT tenant_id) with an instalment due in the window
--
-- `tenants` changes meaning slightly: it was MAX(active_count) (peak concurrent
-- eligible tenants); it is now the distinct tenants actually scheduled to pay in
-- the window. That is the population the expected figure is built from, so the
-- two are now consistent with each other.
--
-- Coverage caveat
-- ---------------
-- `agent_expected_day_plans` starts 2026-06-11 (90 days, no gaps to 2026-09-08),
-- while agent_collections goes back to 2026-03-09. A window that starts before
-- 2026-06-11 therefore reports no expected amount for the un-pinned days —
-- collected still shows, and the rate is suppressed rather than wrong. This is
-- preferred over silently mixing two incompatible bases in one figure.
--
-- Also retained from 20260908200000: the NULL agent_id filter.
--
-- Consumers (all read-only, no ledger path): agent_ops_report_rent_collections,
-- agent_ops_report_agent, agent_ops_report_team_collections. Signature,
-- LANGUAGE sql, STABLE, SECURITY DEFINER and search_path are unchanged.
--
-- Side benefit: this is far cheaper. The eligibility path joined a view that
-- seq-scanned profiles and rent_requests; this is one indexed aggregate over a
-- single table.

CREATE OR REPLACE FUNCTION public.agent_ops_report_expected(p_from date, p_to date)
 RETURNS TABLE(agent_id uuid, expected numeric, tenants integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.agent_id,
         COALESCE(SUM(p.expected_ugx), 0)::numeric AS expected,
         COUNT(DISTINCT p.tenant_id)::int          AS tenants
  FROM public.agent_expected_day_plans p
  WHERE p.day BETWEEN p_from AND p_to
    AND p.agent_id IS NOT NULL
  GROUP BY p.agent_id;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_ops_report_expected(date, date) TO authenticated, service_role;
