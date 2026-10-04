-- Add transaction_id column to withdrawal_requests for tracking
ALTER TABLE public.withdrawal_requests
ADD COLUMN IF NOT EXISTS transaction_id TEXT;