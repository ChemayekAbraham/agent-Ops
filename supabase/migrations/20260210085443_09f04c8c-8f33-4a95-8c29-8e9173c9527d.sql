-- Add mobile money registered name column to withdrawal_requests
ALTER TABLE public.withdrawal_requests ADD COLUMN IF NOT EXISTS mobile_money_name TEXT;