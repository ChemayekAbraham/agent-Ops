-- Enable REPLICA IDENTITY FULL for complete row data in realtime updates
ALTER TABLE public.user_receipts REPLICA IDENTITY FULL;

-- Add user_receipts to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_receipts;