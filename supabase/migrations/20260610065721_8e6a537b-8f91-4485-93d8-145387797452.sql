ALTER TABLE public.sms_delivery_log REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.sms_delivery_log;