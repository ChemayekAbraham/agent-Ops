-- Rollback for 20261015200000_agent_ops_network_overview.sql: the migration only adds one read-only function, so there is no data to restore.
-- get_agent_ops_overview, agent_ops_qualifying_agent_ids, tops_smartphone_usage and every other existing function are untouched.
DROP FUNCTION IF EXISTS public.get_agent_ops_network_overview(date, date, numeric);
