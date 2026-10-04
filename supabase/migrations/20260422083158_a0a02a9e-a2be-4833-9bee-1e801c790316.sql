ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_deductions;
ALTER TABLE public.wallet_deductions REPLICA IDENTITY FULL;