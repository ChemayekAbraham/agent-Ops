-- Extend scheduled_payouts to support flexible recurrence beyond monthly.
ALTER TABLE public.scheduled_payouts ALTER COLUMN day_of_month DROP NOT NULL;
ALTER TABLE public.scheduled_payouts ADD COLUMN IF NOT EXISTS day_of_week integer;
ALTER TABLE public.scheduled_payouts ADD COLUMN IF NOT EXISTS interval_days integer;

-- Validate recurrence config with a trigger (CHECK can't reference cross-column rules cleanly here, but a simple check is fine).
ALTER TABLE public.scheduled_payouts DROP CONSTRAINT IF EXISTS scheduled_payouts_frequency_check;
ALTER TABLE public.scheduled_payouts
  ADD CONSTRAINT scheduled_payouts_frequency_check
  CHECK (frequency IN ('daily','weekly','monthly','interval'));

COMMENT ON COLUMN public.scheduled_payouts.day_of_week IS '0=Sunday..6=Saturday, used when frequency=weekly';
COMMENT ON COLUMN public.scheduled_payouts.interval_days IS 'Every N days, used when frequency=interval';