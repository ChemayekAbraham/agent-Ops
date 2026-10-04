CREATE TABLE public.ledger_backfill_corrections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  batch text NOT NULL,
  workflow text NOT NULL,
  original_transaction_group_id uuid NOT NULL,
  original_leg_id uuid NOT NULL,
  original_ledger_scope text NOT NULL,
  original_category text NOT NULL,
  original_direction text NOT NULL,
  original_transaction_date timestamptz NOT NULL,
  correcting_leg_id uuid NOT NULL,
  correcting_ledger_scope text NOT NULL,
  correcting_category text NOT NULL,
  correcting_direction text NOT NULL,
  correcting_account_code text NOT NULL,
  amount numeric NOT NULL,
  imbalance_delta numeric NOT NULL,
  reference_id text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_backfill_corrections_leg_unique UNIQUE (original_leg_id)
);

GRANT SELECT ON public.ledger_backfill_corrections TO authenticated;
GRANT ALL ON public.ledger_backfill_corrections TO service_role;

ALTER TABLE public.ledger_backfill_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance and executives can read backfill corrections"
ON public.ledger_backfill_corrections
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'financial_ops')
);

CREATE TRIGGER trg_touch_ledger_backfill_corrections
BEFORE UPDATE ON public.ledger_backfill_corrections
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_ledger_backfill_corrections_batch ON public.ledger_backfill_corrections (batch);
CREATE INDEX idx_ledger_backfill_corrections_group ON public.ledger_backfill_corrections (original_transaction_group_id);