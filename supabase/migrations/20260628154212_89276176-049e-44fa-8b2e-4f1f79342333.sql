-- Add an updated_at column so the notification log can track when an SMS/email
-- moved from "queued" to its final delivery state (sent/failed).
ALTER TABLE public.withdrawal_notification_log
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now();

-- Keep updated_at fresh on every status transition.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_withdrawal_notification_log_updated_at ON public.withdrawal_notification_log;
CREATE TRIGGER trg_withdrawal_notification_log_updated_at
  BEFORE UPDATE ON public.withdrawal_notification_log
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Index to make status filtering fast in the Financial Ops panel.
CREATE INDEX IF NOT EXISTS idx_withdrawal_notification_log_status
  ON public.withdrawal_notification_log (status);