-- Rollback for 20261016190000_agent_ops_metrics_quality_risk.sql: only two read-only functions were added, so there is no data to restore.
-- The five agent_ops_metrics_* functions and the _aom_* helpers of 20261016100000 are untouched.
DROP FUNCTION IF EXISTS public.agent_ops_metrics_risk(date, date, integer, integer);
DROP FUNCTION IF EXISTS public.agent_ops_metrics_listing_quality(date, date, integer, integer);
