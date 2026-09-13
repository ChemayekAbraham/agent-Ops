-- Item 8 of tying every action to an IP address: audit_logs itself.
--
-- audit_logs is already the de facto central audit table in this codebase
-- (395k+ rows, 416 distinct action_type values as of this migration,
-- written to directly by ~190 separate RPC functions covering financial
-- corrections, agent/landlord/tenant reassignments, KYC/verification
-- decisions, advance and portfolio actions, ledger maintenance mode,
-- fraud blocks, staff access resets, and more). It carried no IP/user-agent
-- capture.
--
-- Rather than editing ~190 individual RPC functions to each pass through an
-- IP, a single BEFORE INSERT trigger on the table captures it once for
-- every current and future writer -- the same approach already used for
-- login_phase_events (20260913240000), which also has many indirect
-- writers. No RPC function's own logic is touched by this migration.
--
-- Same request.headers pattern as the rest of the series, non-blocking.

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE OR REPLACE FUNCTION public.capture_audit_log_ip()
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
  NEW.user_agent := coalesce(NEW.user_agent, v_headers ->> 'user-agent');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_capture_audit_log_ip ON public.audit_logs;
CREATE TRIGGER trg_capture_audit_log_ip
  BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.capture_audit_log_ip();
