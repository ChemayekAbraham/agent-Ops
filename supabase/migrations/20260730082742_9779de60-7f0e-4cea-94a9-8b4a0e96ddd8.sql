CREATE TABLE IF NOT EXISTS public.requisition_wallet_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table text NOT NULL,
  requisition_id uuid NOT NULL,
  requisition_code text,
  user_id uuid NOT NULL,
  approver_id uuid,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'UGX',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','credited','failed')),
  wallet_transaction_id text,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 1,
  approved_at timestamptz,
  credited_at timestamptz,
  ip_address text,
  device_info text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requisition_wallet_credits_unique UNIQUE (source_table, requisition_id)
);

GRANT SELECT ON public.requisition_wallet_credits TO authenticated;
GRANT ALL ON public.requisition_wallet_credits TO service_role;

ALTER TABLE public.requisition_wallet_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view requisition wallet credits"
ON public.requisition_wallet_credits
FOR SELECT
TO authenticated
USING (public.is_welile_staff(auth.uid()) OR user_id = auth.uid());

CREATE TRIGGER update_requisition_wallet_credits_updated_at
BEFORE UPDATE ON public.requisition_wallet_credits
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_requisition_wallet_credits_status
  ON public.requisition_wallet_credits (status, created_at DESC);

ALTER TABLE public.director_requisitions
  ADD COLUMN IF NOT EXISTS wallet_credit_status text,
  ADD COLUMN IF NOT EXISTS wallet_transaction_id text,
  ADD COLUMN IF NOT EXISTS credited_at timestamptz,
  ADD COLUMN IF NOT EXISTS credited_by uuid;

ALTER TABLE public.employee_requisitions
  ADD COLUMN IF NOT EXISTS wallet_credit_status text,
  ADD COLUMN IF NOT EXISTS wallet_transaction_id text,
  ADD COLUMN IF NOT EXISTS credited_at timestamptz,
  ADD COLUMN IF NOT EXISTS credited_by uuid;