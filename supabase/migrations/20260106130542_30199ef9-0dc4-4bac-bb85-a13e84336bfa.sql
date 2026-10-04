-- Add column to track which manager processed the deposit request
ALTER TABLE public.deposit_requests 
ADD COLUMN IF NOT EXISTS processed_by uuid REFERENCES auth.users(id);

-- Add index for analytics queries
CREATE INDEX IF NOT EXISTS idx_deposit_requests_status ON public.deposit_requests(status);
CREATE INDEX IF NOT EXISTS idx_deposit_requests_created_at ON public.deposit_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_deposit_requests_processed_by ON public.deposit_requests(processed_by);