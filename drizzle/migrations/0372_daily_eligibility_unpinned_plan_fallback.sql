-- Agents whose counted Rent Plans have no pinned bill row (stuck in 'funded', or outside the
-- schedule) showed a target of UGX 0 while still being counted as active. Fallback: when a
-- counted daily plan (or a lapsed weekly plan) has NO pinned row for today/yesterday, its due
-- amount is LEAST(daily_repayment, outstanding). Pinned plans are untouched.
DO $mig$
DECLARE s text; fb text; k text; o text;
BEGIN
  s := pg_get_viewdef('public.v_agent_daily_eligibility'::regclass);
  fb := '(CASE WHEN pd.rent_request_id IS NULL AND ((NOT lr.is_weekly) OR lr.weekly_lapsed) AND COALESCE(lr.daily_repayment,0)>0 THEN LEAST(lr.daily_repayment, GREATEST(COALESCE(lr.total_repayment,0)-COALESCE(lr.amount_repaid,0),0)) ELSE NULL END)';
  FOREACH k IN ARRAY ARRAY['today','yesterday'] LOOP
    o := 'WHEN (COALESCE(lr.daily_repayment, (0)::numeric) > (0)::numeric) THEN LEAST(COALESCE(pd.pin_'||k||', (0)::numeric)';
    IF position(o IN s) = 0 THEN RAISE EXCEPTION 'pattern % not found', k; END IF;
    s := replace(s, o, 'WHEN pd.rent_request_id IS NULL THEN COALESCE('||fb||', (0)::numeric) '||o);
    o := '(COALESCE(pd.pin_'||k||', (0)::numeric) > (0)::numeric) AS due_'||k;
    IF position(o IN s) = 0 THEN RAISE EXCEPTION 'flag % not found', k; END IF;
    s := replace(s, o, '((COALESCE(pd.pin_'||k||', (0)::numeric) > (0)::numeric) OR COALESCE('||fb||',0) > 0) AS due_'||k);
  END LOOP;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS ' || s;
END $mig$;