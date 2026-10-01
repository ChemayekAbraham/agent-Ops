-- Narrow the 0372 fallback to agents with NO pinned bill today/yesterday (same scope as the
-- pin's past-term fallback), so agents who already have a real bill are not re-measured.
DO $mig$
DECLARE s text; o text;
BEGIN
  s := pg_get_viewdef('public.v_agent_daily_eligibility'::regclass);
  o := 'WHEN ((pd.rent_request_id IS NULL) AND ((NOT lr.is_weekly) OR lr.weekly_lapsed)';
  IF position(o IN s) = 0 THEN RAISE EXCEPTION 'fallback pattern not found'; END IF;
  s := replace(s, o, 'WHEN ((pd.rent_request_id IS NULL) AND (NOT EXISTS (SELECT 1 FROM public.agent_expected_day_plans xb WHERE xb.agent_id = lr.agent_id AND xb.day >= (((now() AT TIME ZONE ''Africa/Kampala''::text))::date - 1))) AND ((NOT lr.is_weekly) OR lr.weekly_lapsed)');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS ' || s;
END $mig$;