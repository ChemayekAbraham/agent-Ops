-- Add 'email_receipt_possible_match' as an allowed deposit_match_alerts
-- alert_type. Used by gmail-poll-transactions when an MTN "received" receipt
-- carries only a payer NAME (no phone), the exact name match found nothing,
-- but a looser token-based match found exactly one plausible profile. That
-- case must never auto-credit (too low confidence), but it must not vanish
-- either — this gives Financial Ops a concrete "possible match" to confirm
-- with one click instead of only a bare "unknown sender" receipt with no
-- lead. Kept as its own alert_type (distinct from 'email_receipt_unmatched')
-- so the existing detect_deposit_match_failures() sweep never overwrites the
-- suggested-candidate details written here.
ALTER TABLE public.deposit_match_alerts
  DROP CONSTRAINT IF EXISTS deposit_match_alerts_alert_type_check;
ALTER TABLE public.deposit_match_alerts
  ADD CONSTRAINT deposit_match_alerts_alert_type_check
  CHECK (alert_type = ANY (ARRAY[
    'deposit_unmatched'::text,
    'email_receipt_unmatched'::text,
    'gmail_auth_failure'::text,
    'merchant_float_uncredited'::text,
    'email_receipt_possible_match'::text
  ]));
