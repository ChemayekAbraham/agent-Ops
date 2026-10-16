-- Rollback for 20261016200000_tenant_ops_rent_request_lifetime.sql: the migration only adds one read-only function, so there is no data to restore.
DROP FUNCTION IF EXISTS public.tenant_ops_rent_request_lifetime();
