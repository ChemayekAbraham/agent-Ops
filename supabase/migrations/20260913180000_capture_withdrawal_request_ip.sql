-- Capture the requester's IP address and user agent on every withdrawal
-- request, read from PostgREST's forwarded request headers.
--
-- Motivated by CASE MP-20260913-01 (Mata Pius's disputed UGX 1,500,000
-- withdrawal): withdrawal_requests carries no IP/device evidence of its own,
-- so establishing "was this submitted from the account holder's own device"
-- required reconstructing it from the surrounding auth session's boundaries
-- (login IP before, active session IP after) rather than reading it directly
-- off the row. Every future disputed withdrawal should have this on the row
-- itself.
--
-- Follows the same request.headers capture pattern already used elsewhere in
-- this codebase (see 20260818112344, financial_ops_security_violations).
-- Scope: the client-side insert path (src/components/payments/WithdrawFlow.tsx
-- and equivalents), which is by far the common case. Withdrawal rows created
-- server-side by an edge function (landlord float payouts, tenant funding,
-- etc.) will capture that function's own request context instead of an end
-- user's -- acceptable, since those are system-initiated, not user-submitted.
--
-- Non-blocking by design: if headers are unavailable for any reason (a
-- service-role call, an unusual context), the trigger silently no-ops rather
-- than ever failing a real withdrawal over telemetry.

ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS request_ip_address text,
  ADD COLUMN IF NOT EXISTS request_user_agent text;

CREATE OR REPLACE FUNCTION public.capture_withdrawal_request_client_context()
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
  -- Telemetry capture must never block a real withdrawal.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_capture_withdrawal_request_client_context ON public.withdrawal_requests;
CREATE TRIGGER trg_capture_withdrawal_request_client_context
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.capture_withdrawal_request_client_context();
