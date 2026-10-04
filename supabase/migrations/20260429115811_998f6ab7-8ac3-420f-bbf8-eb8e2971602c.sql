ALTER TABLE public.payroll_batches
  ADD COLUMN IF NOT EXISTS default_recovery_percent numeric NOT NULL DEFAULT 30
    CHECK (default_recovery_percent BETWEEN 0 AND 100);

ALTER TABLE public.payroll_items
  ADD COLUMN IF NOT EXISTS recovery_percent numeric CHECK (recovery_percent BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS advance_balance_snapshot numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS take_home_amount numeric NOT NULL DEFAULT 0;