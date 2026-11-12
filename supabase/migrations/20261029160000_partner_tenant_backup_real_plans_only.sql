-- Narrow the daily Supporter & tenant backup to real Rent Plans and portfolios.
--
-- 20261022120000 counted anyone with ANY rent_requests row as a tenant, so each
-- backup held 6,885 people, ~3,654 of them ordinary users whose request is
-- stuck in service_center_review and who never got a Rent Plan. It also copied
-- rent_requests, repayments and agent_collections whole.
--
-- From now on (the user's definition, 2026-10-28):
--   tenant    = has a Rent Plan: rent_requests.status funded, repaying or completed
--   Supporter = has a portfolio:  investor_portfolios.status active, redeemed or locked
-- and every table holds only those people's rows:
--   profiles, wallets          -> rows of those people
--   rent_requests              -> only the Rent Plans themselves (not old rejected requests)
--   investor_portfolios        -> only active / redeemed / locked portfolios
--   repayments, agent_collections -> rows of tenants with a Rent Plan
-- The status lists live only in the two *_ids() helpers below.

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_tenant_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT tenant_id FROM public.rent_requests
  WHERE status IN ('funded', 'repaying', 'completed') AND tenant_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_partner_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT investor_id FROM public.investor_portfolios
  WHERE status IN ('active', 'redeemed', 'locked') AND investor_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_manifest()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH tenants AS (SELECT * FROM public.partner_tenant_backup_tenant_ids() AS t(id)),
  partners AS (SELECT * FROM public.partner_tenant_backup_partner_ids() AS p(id)),
  people AS (SELECT id FROM tenants UNION SELECT id FROM partners),
  cols AS (
    SELECT c.table_name::text AS table_name,
           jsonb_agg(c.column_name::text ORDER BY (c.column_name <> 'id'), c.ordinal_position) AS columns
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name IN ('profiles', 'wallets', 'investor_portfolios', 'rent_requests', 'repayments', 'agent_collections')
      AND NOT (c.table_name = 'investor_portfolios' AND c.column_name IN ('portfolio_pin', 'activation_token'))
    GROUP BY c.table_name
  )
  SELECT jsonb_build_object(
    'partners', (SELECT count(*) FROM partners),
    'tenants', (SELECT count(*) FROM tenants),
    'columns', (SELECT jsonb_object_agg(table_name, columns) FROM cols),
    'rows', jsonb_build_object(
      'profiles', (SELECT count(*) FROM public.profiles WHERE id IN (SELECT id FROM people)),
      'wallets', (SELECT count(*) FROM public.wallets WHERE user_id IN (SELECT id FROM people)),
      'investor_portfolios', (SELECT count(*) FROM public.investor_portfolios WHERE status IN ('active', 'redeemed', 'locked')),
      'rent_requests', (SELECT count(*) FROM public.rent_requests WHERE status IN ('funded', 'repaying', 'completed')),
      'repayments', (SELECT count(*) FROM public.repayments WHERE tenant_id IN (SELECT id FROM tenants)),
      'agent_collections', (SELECT count(*) FROM public.agent_collections WHERE tenant_id IN (SELECT id FROM tenants))
    )
  );
$$;

-- One page per call, keyset by id: id > p_after (null = from the start),
-- id <= p_through (null = no bound). Same shape as the 20261022120000 pair.
CREATE OR REPLACE FUNCTION public.partner_tenant_backup_profiles(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.profiles
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p.* FROM public.profiles p
  WHERE p.id IN (SELECT public.partner_tenant_backup_tenant_ids()
                 UNION SELECT public.partner_tenant_backup_partner_ids())
    AND (p_after IS NULL OR p.id > p_after)
    AND (p_through IS NULL OR p.id <= p_through)
  ORDER BY p.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_wallets(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.wallets
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT w.* FROM public.wallets w
  WHERE w.user_id IN (SELECT public.partner_tenant_backup_tenant_ids()
                      UNION SELECT public.partner_tenant_backup_partner_ids())
    AND (p_after IS NULL OR w.id > p_after)
    AND (p_through IS NULL OR w.id <= p_through)
  ORDER BY w.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_portfolios(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.investor_portfolios
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT ip.* FROM public.investor_portfolios ip
  WHERE ip.status IN ('active', 'redeemed', 'locked')
    AND (p_after IS NULL OR ip.id > p_after)
    AND (p_through IS NULL OR ip.id <= p_through)
  ORDER BY ip.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_rent_plans(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.rent_requests
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT rr.* FROM public.rent_requests rr
  WHERE rr.status IN ('funded', 'repaying', 'completed')
    AND (p_after IS NULL OR rr.id > p_after)
    AND (p_through IS NULL OR rr.id <= p_through)
  ORDER BY rr.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_repayments(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.repayments
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT r.* FROM public.repayments r
  WHERE r.tenant_id IN (SELECT public.partner_tenant_backup_tenant_ids())
    AND (p_after IS NULL OR r.id > p_after)
    AND (p_through IS NULL OR r.id <= p_through)
  ORDER BY r.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION public.partner_tenant_backup_collections(
  p_after uuid DEFAULT NULL, p_through uuid DEFAULT NULL, p_limit integer DEFAULT 1000)
RETURNS SETOF public.agent_collections
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT ac.* FROM public.agent_collections ac
  WHERE ac.tenant_id IN (SELECT public.partner_tenant_backup_tenant_ids())
    AND (p_after IS NULL OR ac.id > p_after)
    AND (p_through IS NULL OR ac.id <= p_through)
  ORDER BY ac.id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

-- Bulk personal data: service_role only. (CREATE OR REPLACE kept the grants on
-- the three functions from 20261022120000; restated here so this file stands alone.)
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.partner_tenant_backup_tenant_ids()',
    'public.partner_tenant_backup_partner_ids()',
    'public.partner_tenant_backup_manifest()',
    'public.partner_tenant_backup_profiles(uuid, uuid, integer)',
    'public.partner_tenant_backup_wallets(uuid, uuid, integer)',
    'public.partner_tenant_backup_portfolios(uuid, uuid, integer)',
    'public.partner_tenant_backup_rent_plans(uuid, uuid, integer)',
    'public.partner_tenant_backup_repayments(uuid, uuid, integer)',
    'public.partner_tenant_backup_collections(uuid, uuid, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END
$$;
