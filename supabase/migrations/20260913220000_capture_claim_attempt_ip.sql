-- Item 4: capture IP/user-agent on every merchant claim attempt.
--
-- withdrawal_claim_attempts (added in 20260912010000, the claim-flow
-- rebuild) already logs every claim attempt -- success, failure, race-lost,
-- idempotent retry -- through the single merchant_claim_log() insert point.
-- It carries no device/IP evidence today. This is the "who claimed this
-- payout, from where" half of CASE MP-20260913-01; items 1-3 in this series
-- covered the money-movement and account-change side.
--
-- Same request.headers pattern as the rest of the series. Nested inside the
-- function's own existing top-level exception handler ("Telemetry must
-- never decide a claim"), with its own inner handler so a header-parsing
-- hiccup degrades to null IP/UA rather than skipping the log entry entirely.

ALTER TABLE public.withdrawal_claim_attempts
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE OR REPLACE FUNCTION public.merchant_claim_log(
  p_withdrawal_id uuid, p_agent_user_id uuid, p_desk_id uuid, p_result_code text,
  p_error_code text DEFAULT NULL, p_idempotent boolean DEFAULT false,
  p_race_lost boolean DEFAULT false, p_blocking_withdrawal_id uuid DEFAULT NULL,
  p_reservation_outcome text DEFAULT NULL, p_detail text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
    IF v_ip IS NULL THEN
      v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
    END IF;
    v_ua := v_headers ->> 'user-agent';
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  INSERT INTO public.withdrawal_claim_attempts (
    withdrawal_id, agent_user_id, desk_id, result_code, error_code, idempotent,
    race_lost, blocking_withdrawal_id, reservation_outcome, detail, ip_address, user_agent)
  VALUES (
    p_withdrawal_id, p_agent_user_id, p_desk_id, p_result_code, p_error_code, p_idempotent,
    p_race_lost, p_blocking_withdrawal_id, p_reservation_outcome, left(p_detail, 500), v_ip, v_ua);
EXCEPTION WHEN OTHERS THEN
  -- Telemetry must never decide a claim.
  RAISE WARNING 'withdrawal_claim_attempts insert failed: %', SQLERRM;
END;
$function$;
