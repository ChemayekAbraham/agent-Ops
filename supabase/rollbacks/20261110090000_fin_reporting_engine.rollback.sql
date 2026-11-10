-- Rollback for 20261110090000_fin_reporting_engine.sql (reporting only; no data other than the three seed tables).
DROP FUNCTION IF EXISTS public.fin_controls(timestamptz);
DROP FUNCTION IF EXISTS public.fin_cash_flow(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.fin_balance_sheet(timestamptz);
DROP FUNCTION IF EXISTS public.fin_income_statement(timestamptz, timestamptz);
DROP TABLE IF EXISTS public.fin_cash_accounts;
DROP TABLE IF EXISTS public.fin_cash_flow_map;
DROP TABLE IF EXISTS public.fin_pnl_lines;
DROP FUNCTION IF EXISTS public._fin_can_view();
