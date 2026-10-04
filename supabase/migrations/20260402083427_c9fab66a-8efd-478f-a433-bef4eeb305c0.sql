ALTER TABLE public.withdrawal_requests 
ADD COLUMN IF NOT EXISTS fin_ops_approved_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS fin_ops_approved_by UUID;