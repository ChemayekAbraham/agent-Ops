
-- Table to track wallet deductions for audit
CREATE TABLE public.wallet_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID NOT NULL,
  deducted_by UUID NOT NULL,
  amount NUMERIC NOT NULL,
  category TEXT NOT NULL DEFAULT 'general_adjustment',
  reason TEXT NOT NULL,
  ledger_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: only financial ops staff can read
ALTER TABLE public.wallet_deductions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view wallet deductions"
  ON public.wallet_deductions FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'coo')
  );

-- No direct insert from client — edge function uses service role
