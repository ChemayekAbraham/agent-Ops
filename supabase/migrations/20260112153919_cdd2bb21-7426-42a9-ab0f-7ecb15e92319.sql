-- Add approval_comment and rejected_reason columns to rent_requests table
ALTER TABLE public.rent_requests
ADD COLUMN IF NOT EXISTS approval_comment TEXT,
ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

-- Add index for agent_id to improve query performance
CREATE INDEX IF NOT EXISTS idx_rent_requests_agent_id ON public.rent_requests(agent_id);

-- Create a view for agents to see all pending rent requests
COMMENT ON COLUMN public.rent_requests.approval_comment IS 'Comment added by agent/manager when approving a request';
COMMENT ON COLUMN public.rent_requests.rejected_reason IS 'Reason provided by agent/manager when rejecting a request';