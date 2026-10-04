-- Clean up system_events and related automation_actions
TRUNCATE TABLE public.automation_actions, public.system_events CASCADE;