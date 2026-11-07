-- Rollback of 20261108090000_cfo_tenant_repayment_tracker: drops the four read-only functions. No data is touched
-- (the migration created no table, row, trigger or policy).
BEGIN;
DROP FUNCTION IF EXISTS public.get_cfo_tenant_repayment_detail(uuid);
DROP FUNCTION IF EXISTS public.get_cfo_tenant_repayment_register();
DROP FUNCTION IF EXISTS public._cfo_tenant_repayment_can_view();
DROP FUNCTION IF EXISTS public._cfo_tenant_repayment_rows(uuid);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108090000';
COMMIT;
