-- tops_agent_period_collection must add up, over all agents, to Tenant Ops Home for the same dates.
-- Read-only. Impersonates the ops test user and, for each range, checks (every DIFF must be within UGX 1, in practice 0.00):
--   sum of agents' expected_ugx   = Home expected
--   sum of agents' collected_ugx  = Home collected
--   sum of agents' short_ugx      = Home pending
--   totals block                  = sum of the rows
--   paid ahead                    = Home collected_total - Home collected
--   one agent's own call          = that agent's row in the all-agents call
-- The block always ends in an exception so nothing can be kept; the report is the exception message.
DO $$
DECLARE
  r record; h jsonb; a jsonb; one jsonb; lines text := ''; agent uuid;
  s_exp numeric; s_col numeric; s_short numeric; s_ahead numeric;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc', true);
  FOR r IN SELECT * FROM (VALUES
    ('Today',               (now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala', (now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala'),
    ('Last 5 days',         ((now() AT TIME ZONE 'Africa/Kampala')::date - 4)::timestamp AT TIME ZONE 'Africa/Kampala', (now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala'),
    ('This month',          date_trunc('month', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala', (date_trunc('month', now() AT TIME ZONE 'Africa/Kampala') + interval '1 month' - interval '1 day') AT TIME ZONE 'Africa/Kampala'),
    ('Custom 15 Sep-1 Oct', '2026-09-15'::timestamptz, '2026-10-01'::timestamptz),
    ('Whole book',          '2026-01-01'::timestamptz, (now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala')
  ) v(label, a, b) LOOP
    h := public.ops_tenant_ops_home_range(r.a, r.b);
    a := public.tops_agent_period_collection(r.a, r.b);
    SELECT sum((x->>'expected_ugx')::numeric), sum((x->>'collected_ugx')::numeric), sum((x->>'short_ugx')::numeric), sum((x->>'paid_ahead_ugx')::numeric)
      INTO s_exp, s_col, s_short, s_ahead FROM jsonb_array_elements(a->'rows') x;
    agent := (a->'rows'->0->>'agent_id')::uuid;
    one := public.tops_agent_period_collection(r.a, r.b, agent);
    lines := lines || format(E'\n%s | agents=%s | home expected=%s collected=%s pending=%s total=%s | sum expected=%s collected=%s short=%s ahead=%s | DIFF expected=%s collected=%s short=%s ahead=%s totals_vs_rows=%s/%s | top agent alone vs row=%s',
      r.label, jsonb_array_length(a->'rows'), h->>'expected', h->>'collected', h->>'pending', h->>'collected_total',
      s_exp, s_col, s_short, s_ahead,
      s_exp - (h->>'expected')::numeric, s_col - (h->>'collected')::numeric, s_short - (h->>'pending')::numeric,
      s_ahead - ((h->>'collected_total')::numeric - (h->>'collected')::numeric),
      (a->'totals'->>'expected_ugx')::numeric - s_exp, (a->'totals'->>'collected_ugx')::numeric - s_col,
      (one->'totals'->>'collected_ugx')::numeric - (a->'rows'->0->>'collected_ugx')::numeric);
  END LOOP;
  RAISE EXCEPTION '%', lines;
END $$;
