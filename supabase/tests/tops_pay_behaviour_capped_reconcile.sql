-- Tenant Payment Behavior (_v2 reports) must agree with Tenant Ops Home.
-- Read-only. Impersonates the ops test user, then for each range checks:
--   self counted + agent counted + other counted  =  Home collected
--   paid ahead (excess)                           =  Home collected_total - Home collected
--   billed on the tab                             =  Home expected
--   short on the tab                              =  Home pending
-- Every DIFF must be 0.00. Edit the ranges as needed. The block always ends in an exception so nothing can be kept;
-- the report is the exception message.
DO $$
DECLARE
  r record; h jsonb; s jsonb; lines text := ''; counted numeric; ahead numeric;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'b9078b67-dc4c-473a-bc88-9510d4bcd0dc', true);
  FOR r IN SELECT * FROM (VALUES
    ('Today',               (now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala', (now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala'),
    ('Last 5 days',         ((now() AT TIME ZONE 'Africa/Kampala')::date - 4)::timestamp AT TIME ZONE 'Africa/Kampala', (now() AT TIME ZONE 'Africa/Kampala')::date::timestamp AT TIME ZONE 'Africa/Kampala'),
    ('This month',          date_trunc('month', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala', (date_trunc('month', now() AT TIME ZONE 'Africa/Kampala') + interval '1 month' - interval '1 day') AT TIME ZONE 'Africa/Kampala'),
    ('Custom 15 Sep-1 Oct', '2026-09-15'::timestamptz, '2026-10-01'::timestamptz)
  ) v(label, a, b) LOOP
    h := public.ops_tenant_ops_home_range(r.a, r.b);
    s := public.tops_payment_behaviour_summary_v2(r.a, r.b);
    counted := (s->'payments'->'self'->>'ugx')::numeric + (s->'payments'->'agent'->>'ugx')::numeric + (s->'payments'->'other'->>'ugx')::numeric;
    ahead := (s->'paid_ahead'->>'paid_ahead_ugx')::numeric;
    lines := lines || format(E'\n%s | home collected=%s total=%s | tab counted=%s ahead=%s | DIFF collected=%s excess=%s expected=%s short=%s',
      r.label, h->>'collected', h->>'collected_total', counted, ahead,
      counted - (h->>'collected')::numeric,
      ahead - ((h->>'collected_total')::numeric - (h->>'collected')::numeric),
      (s->'coverage'->>'billed_ugx')::numeric - (h->>'expected')::numeric,
      (s->'coverage'->>'short_ugx')::numeric - (h->>'pending')::numeric);
  END LOOP;
  RAISE EXCEPTION '%', lines;
END $$;
