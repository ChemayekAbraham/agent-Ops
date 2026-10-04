
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_method text NOT NULL DEFAULT 'mobile_money',
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS bank_account_number text,
  ADD COLUMN IF NOT EXISTS bank_account_name text,
  ADD COLUMN IF NOT EXISTS agent_location text,
  ADD COLUMN IF NOT EXISTS agent_id uuid;
