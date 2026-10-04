
-- Create pending wallet operations table
CREATE TABLE public.pending_wallet_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  direction text NOT NULL CHECK (direction IN ('cash_in', 'cash_out')),
  category text NOT NULL,
  description text,
  source_table text NOT NULL,
  source_id uuid,
  transaction_group_id uuid,
  linked_party text,
  reference_id text,
  account text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

-- Enable RLS
ALTER TABLE public.pending_wallet_operations ENABLE ROW LEVEL SECURITY;

-- Managers can view all
CREATE POLICY "Managers can view all pending operations"
  ON public.pending_wallet_operations FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role));

-- Managers can update (approve/reject)
CREATE POLICY "Managers can update pending operations"
  ON public.pending_wallet_operations FOR UPDATE
  USING (has_role(auth.uid(), 'manager'::app_role));

-- System can insert
CREATE POLICY "System can insert pending operations"
  ON public.pending_wallet_operations FOR INSERT
  WITH CHECK (true);

-- Users can view their own
CREATE POLICY "Users can view own pending operations"
  ON public.pending_wallet_operations FOR SELECT
  USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_pending_ops_status ON public.pending_wallet_operations(status);
CREATE INDEX idx_pending_ops_user_id ON public.pending_wallet_operations(user_id);
CREATE INDEX idx_pending_ops_created ON public.pending_wallet_operations(created_at DESC);
