-- Item 6: capture IP address on every login_phase_events row.
--
-- This is the table that revealed the gap in CASE MP-20260913-01: a second
-- mobile browser session and a one-off desktop browser session both
-- authenticated around Mata Pius's disputed withdrawal, and NEITHER had a
-- recoverable IP anywhere in the system, because login_phase_events (a
-- direct client-side insert via PostgREST -- see src/lib/loginTelemetry.ts)
-- captured user_agent but never ip_address, and those two sessions
-- authenticated from a cached token rather than a fresh OTP login (the only
-- other place IP was ever captured, in otp_login_audit).
--
-- Same request.headers capture pattern as the rest of this series. This
-- table had no existing trigger of any kind; this is a new, dedicated one.
-- Non-blocking: silently no-ops if headers are unavailable, never fails a
-- login/navigation telemetry write (this is a high-volume table -- 875k+
-- rows already -- so the capture must stay cheap and never raise).

ALTER TABLE public.login_phase_events
  ADD COLUMN IF NOT EXISTS ip_address text;

CREATE OR REPLACE FUNCTION public.capture_login_phase_event_ip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_capture_login_phase_event_ip ON public.login_phase_events;
CREATE TRIGGER trg_capture_login_phase_event_ip
  BEFORE INSERT ON public.login_phase_events
  FOR EACH ROW EXECUTE FUNCTION public.capture_login_phase_event_ip();
