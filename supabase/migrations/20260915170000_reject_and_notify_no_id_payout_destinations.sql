-- Auto-reject payout destinations stuck in 'waiting' where the user has
-- submitted NO identity evidence at all (no National ID photo, no selfie) —
-- the "no_id" bucket already distinguished by finops_payout_verification_queue
-- from genuine name-mismatch cases. Confirmed live 2026-09-15: 3,115 of the
-- 3,301 waiting rows (1,887 distinct users) have zero identity photos on file.
--
-- This does not change whether these users CAN withdraw — 'waiting' and
-- 'rejected' both already block payout via the existing 3-layer gate
-- (payout_destination_is_verified / withdrawal_destination_gate). What it adds:
-- a clear status instead of an indefinite silent queue, and a proactive SMS
-- telling the user exactly what to do. The sweep is deliberately batched and
-- deduped (one SMS per user, ever) rather than firing all ~1,887 SMS at once.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS national_id_missing_notified_at timestamptz;

COMMENT ON COLUMN public.profiles.national_id_missing_notified_at IS
  'Set once the reject-unverified-payout-destinations sweep has SMSed this user that they need to submit a National ID + selfie to unlock withdrawals. Prevents repeat SMS on every cron run.';

-- Internal helper for the edge function above: one row per candidate user
-- (never called from the client — SECURITY DEFINER, no grant to
-- authenticated/anon; the edge function reaches it via the service role,
-- which bypasses grants entirely, same as every other service-role-only RPC
-- in this schema).
CREATE OR REPLACE FUNCTION public.candidates_missing_id_payout(p_limit int DEFAULT 100)
RETURNS TABLE(user_id uuid, phone text, destination_ids uuid[])
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p.id, p.phone, array_agg(d.id)
  FROM public.profiles p
  JOIN public.payout_destination_verifications d ON d.user_id = p.id AND d.status = 'waiting'
  WHERE p.national_id_missing_notified_at IS NULL
    AND (p.national_id_photo_path IS NULL OR p.selfie_photo_path IS NULL)
    AND coalesce(btrim(p.phone), '') <> ''
  GROUP BY p.id, p.phone
  LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$$;

REVOKE ALL ON FUNCTION public.candidates_missing_id_payout(int) FROM PUBLIC, authenticated, anon;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('reject-unverified-payout-destinations');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    -- Every 15 minutes, batched (100 users/run) — drains the existing backlog
    -- over a few hours instead of sending ~1,887 SMS in one burst, and keeps
    -- catching new no-ID 'waiting' destinations as they occur going forward.
    PERFORM cron.schedule(
      'reject-unverified-payout-destinations',
      '*/15 * * * *',
      $$select net.http_post(
          url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/reject-unverified-payout-destinations',
          headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
          body:='{}'::jsonb
      );$$
    );
  END IF;
END
$cron$;
