ALTER PUBLICATION supabase_realtime ADD TABLE public.merchandise_sales;
ALTER TABLE public.merchandise_sales REPLICA IDENTITY FULL;