ALTER TABLE public.credit_access_limits REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.credit_access_limits;