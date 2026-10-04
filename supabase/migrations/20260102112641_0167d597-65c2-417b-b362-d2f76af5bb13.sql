-- Create deposit_requests table for pending deposits that need agent approval
CREATE TABLE public.deposit_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  approved_at TIMESTAMP WITH TIME ZONE,
  rejected_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT
);

-- Enable RLS
ALTER TABLE public.deposit_requests ENABLE ROW LEVEL SECURITY;

-- Users can create deposit requests
CREATE POLICY "Users can create deposit requests"
ON public.deposit_requests
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can view their own deposit requests
CREATE POLICY "Users can view own deposit requests"
ON public.deposit_requests
FOR SELECT
USING (auth.uid() = user_id);

-- Agents can view deposit requests assigned to them
CREATE POLICY "Agents can view assigned deposit requests"
ON public.deposit_requests
FOR SELECT
USING (auth.uid() = agent_id);

-- Agents can update deposit requests assigned to them
CREATE POLICY "Agents can update assigned deposit requests"
ON public.deposit_requests
FOR UPDATE
USING (auth.uid() = agent_id AND status = 'pending');

-- Managers can view all deposit requests
CREATE POLICY "Managers can view all deposit requests"
ON public.deposit_requests
FOR SELECT
USING (has_role(auth.uid(), 'manager'::app_role));

-- Add trigger for updated_at
CREATE TRIGGER update_deposit_requests_updated_at
BEFORE UPDATE ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for deposit_requests
ALTER PUBLICATION supabase_realtime ADD TABLE public.deposit_requests;