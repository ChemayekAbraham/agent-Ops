
-- Truncate all existing system_events data (CASCADE clears FK refs in automation_actions)
TRUNCATE public.system_events CASCADE;
