-- Rollback for 20261006150000_sms_cost_daily_rpc.sql
DROP FUNCTION IF EXISTS public.get_sms_cost_daily(integer);
