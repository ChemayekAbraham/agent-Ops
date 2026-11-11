-- Rollback of 20261113040000_cfo_daily_cash_movement.sql. The Cash Position chart must be pointed back at
-- get_cfo_daily_cash_flow first (src/components/cfo/CashPositionInsights.tsx), or it will show an error.
drop function if exists public.get_cfo_daily_cash_movement(integer);
