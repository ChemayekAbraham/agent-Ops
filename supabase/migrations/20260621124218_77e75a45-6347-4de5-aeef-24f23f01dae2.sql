-- Auto-deduction scheduling for lending-agent loans
ALTER TABLE public.lending_agent_loans
  ADD COLUMN IF NOT EXISTS repayment_frequency text NOT NULL DEFAULT 'once',
  ADD COLUMN IF NOT EXISTS auto_deduct_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS installment_ugx numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_deduction_date date,
  ADD COLUMN IF NOT EXISTS auto_deduct_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_auto_deduct_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_deduct_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_deduct_collected_ugx numeric NOT NULL DEFAULT 0;

-- Valid repayment cadences
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lending_agent_loans_repayment_frequency_check'
  ) THEN
    ALTER TABLE public.lending_agent_loans
      ADD CONSTRAINT lending_agent_loans_repayment_frequency_check
      CHECK (repayment_frequency IN ('daily','weekly','monthly','once','end_of_month'));
  END IF;
END $$;

-- Index for the cron sweep: find due, auto-enabled, open loans fast
CREATE INDEX IF NOT EXISTS idx_lending_loans_auto_due
  ON public.lending_agent_loans (next_deduction_date)
  WHERE auto_deduct_enabled = true;
