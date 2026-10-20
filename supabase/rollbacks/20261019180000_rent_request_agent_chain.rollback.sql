-- Rollback for 20261019180000_rent_request_agent_chain.sql: only a read-only function was added, so there is no data to restore.
DROP FUNCTION IF EXISTS public.rent_request_agent_chain(uuid[]);
