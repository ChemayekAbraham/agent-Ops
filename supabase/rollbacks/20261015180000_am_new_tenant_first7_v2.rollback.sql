-- Rollback for 20261015180000_am_new_tenant_first7_v2.sql: the migration only adds three read-only functions.
-- am_new_tenant_first7 and every other existing function are untouched, so nothing else needs restoring.
DROP FUNCTION IF EXISTS public.am_new_tenant_first7_payments(uuid);
DROP FUNCTION IF EXISTS public.am_new_tenant_first7_summary_v2(date, date, text, uuid);
DROP FUNCTION IF EXISTS public.am_new_tenant_first7_v2(date, date, text, uuid);
