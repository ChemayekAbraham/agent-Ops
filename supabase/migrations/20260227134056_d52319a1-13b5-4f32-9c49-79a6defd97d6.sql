
-- Add rewards_paused flag to investment_withdrawal_requests
ALTER TABLE public.investment_withdrawal_requests 
  ADD COLUMN IF NOT EXISTS rewards_paused boolean NOT NULL DEFAULT true;

-- Add a comment for clarity
COMMENT ON COLUMN public.investment_withdrawal_requests.rewards_paused IS 'When true, monthly supporter rewards are paused for this user. Set to true on withdrawal request submission.';
