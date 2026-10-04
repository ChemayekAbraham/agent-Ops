ALTER TABLE public.withdrawal_requests 
ADD COLUMN IF NOT EXISTS payout_proof text,
ADD COLUMN IF NOT EXISTS payout_proof_type text;