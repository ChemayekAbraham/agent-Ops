-- 2026-10-13 CTO report: stop counting Yoola attempts that Africa's Talking rescued,
-- and stop blaming the providers for numbers that cannot receive an SMS.
--
-- Every send path tries Yoola, then Africa's Talking, then Lana. Several of them
-- (attemptYoolaPrimary and the ~24 inline senders) write one sms_delivery_log row
-- PER ATTEMPT, so a Yoola 402 leaves a status='failed' row even when AT delivered
-- the same message seconds later. get_cto_daily_report counted those rows, which
-- is why 10-11/10-12 showed ~640 "failures" and "SMS not rejected 84.5%".
-- Measured 2026-10-13 over the 30 days: 11,252 failed rows (14.6%); 4,962 had a
-- successful row for the same number within -1/+10 minutes, and 548 were bad
-- numbers (yoola_422_invalid_phone_format, AT InvalidPhoneNumber, no valid number
-- on file). Genuine undelivered messages: 5,742 (8.0% of rows that were not
-- recovered).
--
-- Rows are NOT rewritten: the audit trail keeps every attempt. Only the report's
-- definition of "failed" changes.

CREATE OR REPLACE FUNCTION public.sms_row_is_recovered(p_status text, p_phone text, p_at timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT p_status = 'failed' AND EXISTS (
    SELECT 1 FROM public.sms_delivery_log s
    WHERE s.status IN ('sent', 'accepted', 'delivered')
      AND s.created_at BETWEEN p_at - interval '1 minute' AND p_at + interval '10 minutes'
      AND right(regexp_replace(COALESCE(s.recipient_phone, ''), '\D', '', 'g'), 9)
        = right(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), 9)
  );
$$;

CREATE OR REPLACE FUNCTION public.sms_row_invalid_destination(p_error text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(p_error, '') ~* '(invalid_phone|InvalidPhoneNumber|invalid ugandan|no valid ugandan|has no phone on profile)';
$$;

-- Patch get_cto_daily_report in place (the live body is long and drifts from the repo
-- copy, so edit what is actually deployed and refuse to continue if an anchor is missing).
DO $patch$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname = 'get_cto_daily_report' AND p.pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_cto_daily_report not found'; END IF;
  v_new := v_def;

  -- 1. Drop recovered attempts from the SMS and OTP populations.
  v_new := replace(v_new,
    E'WHERE created_at >= v_30d AND created_at <= v_end\n      AND NOT (',
    E'WHERE created_at >= v_30d AND created_at <= v_end\n      AND NOT public.sms_row_is_recovered(status, recipient_phone, created_at)\n      AND NOT (');
  v_new := replace(v_new,
    E'WHERE source = ''sms-otp'' AND created_at >= v_30d AND created_at <= v_end\n      AND NOT (',
    E'WHERE source = ''sms-otp'' AND created_at >= v_30d AND created_at <= v_end\n      AND NOT public.sms_row_is_recovered(status, recipient_phone, created_at)\n      AND NOT (');

  -- 2. Provider failures exclude undeliverable numbers, which get their own line.
  v_new := replace(v_new,
    E'''failed'', count(*) FILTER (WHERE status = ''failed''),',
    E'''failed'', count(*) FILTER (WHERE status = ''failed'' AND NOT public.sms_row_invalid_destination(error)),\n    ''invalid_destination'', count(*) FILTER (WHERE status = ''failed'' AND public.sms_row_invalid_destination(error)),\n    ''failover_recovered_30d'', (SELECT count(*) FROM public.sms_delivery_log r WHERE r.status = ''failed'' AND r.created_at >= v_30d AND r.created_at <= v_end AND public.sms_row_is_recovered(r.status, r.recipient_phone, r.created_at)),');
  v_new := replace(v_new,
    E'''failure_rate'', round(100.0 * count(*) FILTER (WHERE status = ''failed'') /',
    E'''failure_rate'', round(100.0 * count(*) FILTER (WHERE status = ''failed'' AND NOT public.sms_row_invalid_destination(error)) /');
  v_new := replace(v_new,
    E'''sends_failed_30d'', (SELECT count(*) FROM sms_otp_dedup WHERE status = ''failed''),',
    E'''sends_failed_30d'', (SELECT count(*) FROM sms_otp_dedup WHERE status = ''failed'' AND NOT public.sms_row_invalid_destination(error)),\n    ''sends_invalid_destination_30d'', (SELECT count(*) FROM sms_otp_dedup WHERE status = ''failed'' AND public.sms_row_invalid_destination(error)),');

  IF v_new = v_def THEN RAISE EXCEPTION 'get_cto_daily_report: no anchor matched, nothing patched'; END IF;
  IF position('sms_row_is_recovered' in v_new) = 0
     OR position('sms_row_invalid_destination' in v_new) = 0
     OR (length(v_new) - length(replace(v_new, 'sms_row_is_recovered', ''))) / length('sms_row_is_recovered') < 3
     OR (length(v_new) - length(replace(v_new, 'sms_row_invalid_destination', ''))) / length('sms_row_invalid_destination') < 5
  THEN
    RAISE EXCEPTION 'get_cto_daily_report: only part of the patch matched, aborting';
  END IF;

  EXECUTE v_new;
END
$patch$;
