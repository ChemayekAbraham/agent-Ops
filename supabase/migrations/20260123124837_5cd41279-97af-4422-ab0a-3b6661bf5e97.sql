-- Add mobile money columns to withdrawal_requests table
ALTER TABLE public.withdrawal_requests
ADD COLUMN IF NOT EXISTS mobile_money_number TEXT,
ADD COLUMN IF NOT EXISTS mobile_money_provider TEXT;