-- Rollback for 20261005150000_liquidity_forecast_single_source.sql
-- Removes the shared forecast function. Nothing else changed in that migration; clients that have not been switched to it
-- keep working on their own calculations.

DROP FUNCTION IF EXISTS public.get_liquidity_forecast(integer);
