-- Item 5: capture requester IP/user-agent on every deposit request.
--
-- Same rationale and pattern as item 1 (20260913180000, withdrawal_
-- requests): deposit_requests carried no device/IP evidence of its own.
-- Scope is deliberately the direct user-initiated deposit request only --
-- field_deposit_batches (an agent submitting field-collected cash on a
-- depositor's behalf) is a different actor and a separate item, not folded
-- in here.
--
-- Non-blocking by design: if headers are unavailable, the trigger silently
-- no-ops rather than ever failing a real deposit submission.

ALTER TABLE public.deposit_requests
  ADD COLUMN IF NOT EXISTS request_ip_address text,
  ADD COLUMN IF NOT EXISTS request_user_agent text;

CREATE OR REPLACE FUNCTION public.capture_deposit_request_client_context()
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

  NEW.request_ip_address := coalesce(NEW.request_ip_address, v_ip);
  NEW.request_user_agent := coalesce(NEW.request_user_agent, v_headers ->> 'user-agent');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_capture_deposit_request_client_context ON public.deposit_requests;
CREATE TRIGGER trg_capture_deposit_request_client_context
  BEFORE INSERT ON public.deposit_requests
  FOR EACH ROW EXECUTE FUNCTION public.capture_deposit_request_client_context();
