-- Rollback for 20261015100000_landlord_tenant_overview.sql
-- The migration only adds two read-only functions, so removing them is the whole rollback. No data, table, policy or existing function was touched.
DROP FUNCTION IF EXISTS public.landlord_ops_paid_lists(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.landlord_tenant_overview(uuid);
