ALTER TABLE public.sms_delivery_log
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Only one delivery row per idempotency key (keys are null for legacy/other SMS).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_delivery_log_idempotency_key
  ON public.sms_delivery_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL;