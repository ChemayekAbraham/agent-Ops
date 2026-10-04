ALTER TABLE public.deposit_match_alerts
  DROP CONSTRAINT IF EXISTS deposit_match_alerts_alert_type_check;
ALTER TABLE public.deposit_match_alerts
  ADD CONSTRAINT deposit_match_alerts_alert_type_check
  CHECK (alert_type = ANY (ARRAY['deposit_unmatched'::text, 'email_receipt_unmatched'::text, 'gmail_auth_failure'::text, 'merchant_float_uncredited'::text]));

ALTER TABLE public.deposit_match_alerts
  DROP CONSTRAINT IF EXISTS deposit_match_alerts_severity_check;
ALTER TABLE public.deposit_match_alerts
  ADD CONSTRAINT deposit_match_alerts_severity_check
  CHECK (severity = ANY (ARRAY['low'::text, 'medium'::text, 'warning'::text, 'high'::text, 'critical'::text]));