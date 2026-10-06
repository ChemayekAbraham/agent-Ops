-- Rollback for 20261006160000_tops_agent_period_collection.sql
-- The migration only ADDED one read-only function; nothing existing was changed, so rolling back is dropping it.
-- (The Management Overview tab then shows its period columns as unavailable; remove them with the frontend change.)
DROP FUNCTION IF EXISTS public.tops_agent_period_collection(timestamptz, timestamptz, uuid);
