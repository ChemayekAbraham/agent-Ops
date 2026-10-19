-- Today's expected, split into in-term rent and arrears.
--
-- Since 20261019104000 the daily bill includes plans past their term end, so an
-- agent's target is a blend of two different jobs. On 2026-10-19 it was UGX
-- 7,361,429 in-term against 10,329,756 arrears across 109 agents — the arrears
-- are the majority — yet the agent's capacity strip shows one opaque figure.
-- NATTU SHARIFAH reads "UGX 214,130" when the honest statement is "197,946
-- today's rent, 16,184 one tenant three days past her term".
--
-- Deliberately a new function rather than two more columns on
-- v_agent_daily_eligibility: changing get_agent_daily_eligibility's return type
-- means dropping and recreating a function that seven other DB functions and
-- tr_detect_agent_unblock sit next to, and whose self-scope escape only landed
-- today (20261019120000). Not worth re-opening for a display field.
--
-- Takes an ARRAY so a fleet screen resolves every agent in one round trip
-- instead of one call per row, and returns a row per requested agent — zeros
-- included — so a caller never has to decide whether a missing row means "no
-- bill" or "not found".
--
-- Reads (agent_id, day), which idx_agent_expected_day_plans_agent already
-- covers, so this is one indexed scan however many agents are asked for.
CREATE OR REPLACE FUNCTION public.agent_expected_split(
  p_agent_ids uuid[] DEFAULT NULL,
  p_day date DEFAULT NULL
)
RETURNS TABLE (
  agent_id uuid,
  in_term_ugx numeric,
  arrears_ugx numeric,
  total_ugx numeric,
  in_term_plans integer,
  arrears_plans integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ids uuid[] := COALESCE(p_agent_ids, ARRAY[auth.uid()]);
  v_day date := COALESCE(p_day, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  -- Same shape of gate as get_agent_daily_eligibility: staff see anyone, an
  -- agent sees only themselves. Containment against a single-element array
  -- means any id other than their own, or a null auth.uid(), still fails.
  IF NOT (
       pg_trigger_depth() > 0
       OR public.can_view_staff_reports(auth.uid())
       OR (
         auth.uid() IS NOT NULL
         AND v_ids IS NOT NULL
         AND array_length(v_ids, 1) IS NOT NULL
         AND v_ids <@ ARRAY[auth.uid()]
       )
     ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT a.id AS agent_id,
         COALESCE(s.in_term_ugx, 0)::numeric,
         COALESCE(s.arrears_ugx, 0)::numeric,
         COALESCE(s.in_term_ugx, 0)::numeric + COALESCE(s.arrears_ugx, 0)::numeric,
         COALESCE(s.in_term_plans, 0)::integer,
         COALESCE(s.arrears_plans, 0)::integer
  FROM unnest(v_ids) AS a(id)
  LEFT JOIN LATERAL (
    SELECT
      sum(e.expected_ugx) FILTER (WHERE NOT x.expired) AS in_term_ugx,
      sum(e.expected_ugx) FILTER (WHERE x.expired)     AS arrears_ugx,
      count(*)            FILTER (WHERE NOT x.expired) AS in_term_plans,
      count(*)            FILTER (WHERE x.expired)     AS arrears_plans
    FROM public.agent_expected_day_plans e
    JOIN public.rent_requests rr ON rr.id = e.rent_request_id
    CROSS JOIN LATERAL (
      SELECT (
        COALESCE(rr.repayment_starts_on, (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date)
        + COALESCE(rr.duration_days, 0) - 1
      ) < v_day AS expired
    ) x
    WHERE e.agent_id = a.id
      AND e.day = v_day
  ) s ON true;
END
$fn$;

REVOKE ALL ON FUNCTION public.agent_expected_split(uuid[], date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_expected_split(uuid[], date) TO authenticated, service_role;

COMMENT ON FUNCTION public.agent_expected_split(uuid[], date) IS
  'Today''s pinned expected per agent, split into in-term rent and arrears (plans past their term end). Staff may ask for any agent; an agent may ask only for themselves. Batched: pass every agent id in one call.';
