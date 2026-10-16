-- Rollback for 20261016100000_agent_ops_metrics.sql: the migration only adds read-only functions, so there is no data to restore.
-- Every existing function (get_agent_ops_overview, get_agent_ops_network_overview, agent_ops_qualifying_agent_ids ...) is untouched.
DROP FUNCTION IF EXISTS public.agent_ops_metrics_main_agents(date, date, integer, integer);
DROP FUNCTION IF EXISTS public.agent_ops_metrics_pins(double precision, double precision, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public.agent_ops_metrics_locations(date, date, text);
DROP FUNCTION IF EXISTS public.agent_ops_metrics_agents(date, date, text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.agent_ops_metrics_totals(date, date);
DROP FUNCTION IF EXISTS public._aom_rows(date, date, text);
DROP FUNCTION IF EXISTS public._aom_scope(text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public._aom_allowed();
