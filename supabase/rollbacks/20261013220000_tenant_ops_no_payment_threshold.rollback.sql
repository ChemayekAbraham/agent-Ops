-- Rollback for 20261013220000_tenant_ops_no_payment_threshold.sql
-- Drops the three new functions. Nothing existing was edited by the migration, so nothing else needs restoring.
DROP FUNCTION IF EXISTS public.get_tenant_ops_dormant_amclock(integer);
DROP FUNCTION IF EXISTS public._tenant_ops_dormant_days_amclock();
DROP FUNCTION IF EXISTS public.get_tenant_ops_no_payment_report_v2(integer, uuid);
