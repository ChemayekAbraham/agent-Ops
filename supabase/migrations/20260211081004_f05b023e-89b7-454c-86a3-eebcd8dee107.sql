-- Add indexes to speed up withdrawal_requests queries
CREATE INDEX idx_withdrawal_requests_status_created ON public.withdrawal_requests (status, created_at DESC);
CREATE INDEX idx_withdrawal_requests_amount ON public.withdrawal_requests (amount);
CREATE INDEX idx_withdrawal_requests_user_id ON public.withdrawal_requests (user_id);