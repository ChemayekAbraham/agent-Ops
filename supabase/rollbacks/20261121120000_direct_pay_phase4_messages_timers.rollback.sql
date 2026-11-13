-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Rollback of 20261121120000_direct_pay_phase4_messages_timers.sql.
-- Refuses while any option 2 message is in the notice queue (narrowing the checks would fail on those rows).
-- Re-runnable.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.self_support_notices
              WHERE ref_type = 'direct_payment' OR audience IN ('tenant', 'proxy_agent') OR event LIKE 'dp\_%') THEN
    RAISE EXCEPTION 'rollback refused: option 2 messages are in self_support_notices';
  END IF;
END
$guard$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'direct-pay-tick') THEN PERFORM cron.unschedule('direct-pay-tick'); END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'direct-pay-reminders') THEN PERFORM cron.unschedule('direct-pay-reminders'); END IF;
  END IF;
END
$cron$;

DROP TRIGGER IF EXISTS zz_direct_pay_messages ON public.funder_offplatform_rent_payments;
DROP FUNCTION IF EXISTS public.direct_pay_send_reminders();
DROP FUNCTION IF EXISTS public.direct_pay_tick();
DROP FUNCTION IF EXISTS public.trg_direct_pay_messages();
DROP FUNCTION IF EXISTS public._direct_pay_notify(uuid, text);
DROP FUNCTION IF EXISTS public._direct_pay_agent_receipt_email(uuid);
ALTER TABLE public.funder_offplatform_rent_payments DROP COLUMN IF EXISTS agent_email_requested_at;

ALTER TABLE public.self_support_notices
  DROP CONSTRAINT IF EXISTS self_support_notices_ref_type_check,
  DROP CONSTRAINT IF EXISTS self_support_notices_audience_check,
  DROP CONSTRAINT IF EXISTS self_support_notices_event_check;
ALTER TABLE public.self_support_notices
  ADD CONSTRAINT self_support_notices_ref_type_check CHECK (ref_type IN ('landlord_payment', 'house_portfolio')),
  ADD CONSTRAINT self_support_notices_audience_check CHECK (audience IN ('partner', 'agent', 'landlord')),
  ADD CONSTRAINT self_support_notices_event_check CHECK (event IN ('queued', 'paid', 'refunded', 'house_active'));
