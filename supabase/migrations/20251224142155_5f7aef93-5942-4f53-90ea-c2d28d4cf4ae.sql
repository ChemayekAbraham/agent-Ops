-- Enable realtime for wallet_transactions table
ALTER TABLE public.wallet_transactions REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.wallet_transactions;

-- Enable realtime for money_requests table
ALTER TABLE public.money_requests REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.money_requests;