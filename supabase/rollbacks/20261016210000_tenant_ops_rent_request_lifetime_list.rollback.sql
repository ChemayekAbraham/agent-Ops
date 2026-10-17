-- Rollback for 20261016210000_tenant_ops_rent_request_lifetime_list.sql: drops the list function and the helper and puts the summary function back
-- to its 20261016200000 body (re-run that migration after this file to restore it exactly). No data to restore.
DROP FUNCTION IF EXISTS public.tenant_ops_rent_request_lifetime_list(text, integer, integer);
-- The summary reads the helper, so it must be re-created from 20261016200000 before the helper goes:
-- psql -f supabase/migrations/20261016200000_tenant_ops_rent_request_lifetime.sql
DROP FUNCTION IF EXISTS public._tor_lifetime_rows();
