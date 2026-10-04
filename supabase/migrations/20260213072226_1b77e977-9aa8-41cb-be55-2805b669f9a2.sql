
-- Remove notifications from realtime publication
ALTER PUBLICATION supabase_realtime DROP TABLE public.notifications;

-- Drop the notifications table
DROP TABLE IF EXISTS public.notifications CASCADE;
