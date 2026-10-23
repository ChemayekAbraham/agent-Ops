-- public_support_plan: the public response must never carry private fields.
-- Run with: psql -f supabase/tests/public_support_plan.sql
BEGIN;

-- 1. Function exists, is read-only (STABLE) and SECURITY DEFINER.
SELECT
  p.prosecdef AS is_security_definer,
  p.provolatile = 's' AS is_stable_readonly
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'public_support_plan';

-- 2. Unknown id returns exactly {"status": "unavailable"} and nothing else.
SELECT public.public_support_plan('00000000-0000-0000-0000-000000000000'::uuid) AS unknown_plan;

-- 3. Whitelist check: for any real plan the returned keys must be a subset of
--    the safe list — never phones, full names, IDs, GPS, agent or wallet data.
WITH sample AS (
  SELECT rent_request_id
  FROM public.v_partner_self_fundable_plans
  WHERE held_by IS NULL
  LIMIT 1
),
resp AS (
  SELECT public.public_support_plan((SELECT rent_request_id FROM sample)) AS body
)
SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), '{}') AS returned_keys
FROM resp, LATERAL jsonb_object_keys(resp.body) AS k;

-- Expected returned_keys:
-- {city, funding_amount, house_category, monthly_return, photo_url, plan_id, status, tenant_first_name, twelve_month_total}
-- Any key outside that list fails this test on inspection.

ROLLBACK;
