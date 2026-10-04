ALTER TABLE public.deposit_bridge_gap_alerts
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS slack_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dbga_unnotified
  ON public.deposit_bridge_gap_alerts(detected_at DESC)
  WHERE resolved_at IS NULL AND notified_at IS NULL;