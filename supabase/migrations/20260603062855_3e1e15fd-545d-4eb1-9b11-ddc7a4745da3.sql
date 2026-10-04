-- Tighten the cash deposit receipt-code window to 2 minutes.
-- If the depositor does not enter the code within 2 minutes, the sweep
-- marks the verification 'expired' and auto-rejects the pending deposit.

-- 1) New codes expire 2 minutes after they are issued.
ALTER TABLE public.cash_deposit_verifications
  ALTER COLUMN expires_at SET DEFAULT (now() + '00:02:00'::interval);

-- 2) Run the expiry sweep every minute so rejection lands right at the limit.
SELECT cron.unschedule('expire-cash-deposit-codes');
SELECT cron.schedule(
  'expire-cash-deposit-codes',
  '* * * * *',
  $$ SELECT public.expire_stale_cash_deposit_codes(); $$
);