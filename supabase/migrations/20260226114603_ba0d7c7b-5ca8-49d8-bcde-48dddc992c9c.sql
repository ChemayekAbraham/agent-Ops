
-- Archive table for voided/removed ledger entries
CREATE TABLE public.voided_ledger_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  original_ledger_id UUID NOT NULL,
  transaction_date TIMESTAMPTZ NOT NULL,
  amount NUMERIC NOT NULL,
  direction TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  reference_id TEXT,
  linked_party TEXT,
  running_balance NUMERIC,
  user_id UUID,
  source_table TEXT NOT NULL,
  source_id UUID,
  account TEXT,
  transaction_group_id UUID,
  -- Void metadata
  voided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_by UUID REFERENCES auth.users NOT NULL,
  void_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: only managers can read/write
ALTER TABLE public.voided_ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can read voided entries"
  ON public.voided_ledger_entries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = auth.uid()
      AND user_roles.role = 'manager'
    )
  );

CREATE POLICY "Managers can insert voided entries"
  ON public.voided_ledger_entries FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = auth.uid()
      AND user_roles.role = 'manager'
    )
  );

-- Index for quick lookups
CREATE INDEX idx_voided_ledger_entries_voided_at ON public.voided_ledger_entries(voided_at DESC);
