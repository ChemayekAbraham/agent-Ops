-- Agent Operations reports: stop counting a phantom agent.
--
-- `public.v_agent_daily_eligibility` emits one row with a NULL `agent_id`
-- (expected_daily = 0, active_count = 0). The history table is clean — the stray
-- row comes from the live view, so it only ever lands in today's slice.
--
-- `agent_ops_report_expected` grouped by `agent_id` without filtering, so that
-- NULL became its own group. The knock-on effect in the Rent Collections report:
--
--   * `kpis.total_agents` does COUNT(*) over this function  -> 162
--   * `rows` filters `COALESCE(e.agent_id, g.agent_id) IS NOT NULL` -> 161
--
-- so the KPI card claimed one more agent than the table could ever list. Money
-- was never affected (the phantom group carries expected = 0), but the two
-- figures contradicted each other on screen.
--
-- Fix at the reporting boundary: a report keyed by agent cannot use a NULL
-- agent. Filtering here corrects every consumer at once —
-- `agent_ops_report_rent_collections`, `agent_ops_report_agent` and
-- `agent_ops_report_team_collections` are the only callers, all read-only, no
-- ledger path.
--
-- The underlying view is deliberately left alone: it feeds the daily collection
-- gate, so the stray row is reported separately rather than patched here.
--
-- Behaviour preserved otherwise: same signature, LANGUAGE sql, STABLE,
-- SECURITY DEFINER, search_path=public, same expected/tenants aggregation.

CREATE OR REPLACE FUNCTION public.agent_ops_report_expected(p_from date, p_to date)
 RETURNS TABLE(agent_id uuid, expected numeric, tenants integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH today AS (SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS d),
  hist AS (
    SELECT h.agent_id, h.day, h.expected_daily, h.active_count
    FROM public.agent_daily_eligibility_history h
    WHERE h.day BETWEEN p_from AND p_to
      AND h.agent_id IS NOT NULL
  ),
  live AS (
    SELECT v.agent_id, t.d AS day, v.expected_daily, v.active_count
    FROM public.v_agent_daily_eligibility v CROSS JOIN today t
    WHERE t.d BETWEEN p_from AND p_to
      AND v.agent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM hist h WHERE h.agent_id = v.agent_id AND h.day = t.d)
  ),
  all_days AS (SELECT * FROM hist UNION ALL SELECT * FROM live)
  SELECT a.agent_id,
         COALESCE(SUM(a.expected_daily),0)::numeric AS expected,
         COALESCE(MAX(a.active_count),0)::int AS tenants
  FROM all_days a
  WHERE a.agent_id IS NOT NULL
  GROUP BY a.agent_id;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_ops_report_expected(date, date) TO authenticated, service_role;
