-- Exception approval by one-time code: nobody can allow an exception (a landlord payout, a landlord float withdrawal or a rent
-- disbursement for an agent under the 50% minimum) unless the approver, joshua.wanda@welile.com, has emailed them a code for that exact
-- request and they enter it.
--
-- HOW IT WORKS (three steps, all in the database)
--   1. request_exception_otp(kind, ids, reason)   emails a 6-digit code to the approver. The email says who asked, what for (the agents,
--                                                 amounts and rates) and the reason, so the approver knows what the code approves.
--   2. verify_exception_otp(kind, ids, reason, otp) checks the code. It never raises on a wrong code: it counts the failed try (5 tries,
--                                                 10 minutes) and answers {verified, message}. That is deliberate: an error would roll back
--                                                 the count and allow unlimited guessing.
--   3. The exception function itself (same name and arguments as today) now refuses unless step 2 succeeded for exactly those ids and
--      that reason. The approval is used up by the exception: one code, one use. The audit log records the approval.
--
-- A code is bound to the person who asked, the kind, the exact set of ids and the exact reason: change any of them and it no longer works.
-- The code is stored only as a hash. The approver's address is the control row 'exception_approver_email' (set below), so it can be changed
-- without a migration. Even the approver must use a code (it goes to their own inbox).
--
-- The three exception functions are renamed to *_unchecked (no access for the app) and replaced by checking wrappers with the old names, so
-- no caller can skip the approval.
-- Needs the exception functions from 20261020150000, 20261022150000 and 20261022100000 to be applied first.
-- Roll back with 20261023150000_exception_approval_otp.rollback.sql.

INSERT INTO public.treasury_controls (control_key, enabled, value)
VALUES ('exception_approver_email', true, 'joshua.wanda@welile.com')
ON CONFLICT (control_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.exception_approval_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('landlord_payout_exception', 'landlord_float_withdrawal', 'rent_disbursement_exception')),
  requested_by  uuid NOT NULL,
  fingerprint   text NOT NULL,
  code_hash     text NOT NULL,
  approver_email text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  expires_at    timestamptz NOT NULL,
  verified_at   timestamptz,
  consumed_at   timestamptz,
  failure_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exception_approval_codes_user_idx ON public.exception_approval_codes (requested_by, created_at DESC);
ALTER TABLE public.exception_approval_codes ENABLE ROW LEVEL SECURITY;
-- No policy: only the functions below read or write it.
GRANT ALL ON public.exception_approval_codes TO service_role;

-- What a code is bound to: kind + the exact sorted ids + the exact reason.
CREATE OR REPLACE FUNCTION public.exception_otp_fingerprint(p_kind text, p_ids uuid[], p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT encode(sha256(convert_to(p_kind || ':' || COALESCE((SELECT string_agg(x::text, ',' ORDER BY x) FROM (SELECT DISTINCT unnest(p_ids) AS x) d), '')
                                  || ':' || btrim(COALESCE(p_reason, '')), 'UTF8')), 'hex');
$function$;
REVOKE ALL ON FUNCTION public.exception_otp_fingerprint(text, uuid[], text) FROM PUBLIC, anon, authenticated;

-- Step 1: email the approver a code.
CREATE OR REPLACE FUNCTION public.request_exception_otp(p_kind text, p_target_ids uuid[], p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ids uuid[];
  v_id uuid := gen_random_uuid();
  v_code text := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  v_to text;
  v_who text;
  v_what text := '';
  v_label text;
  v_html text;
  v_text text;
  v_exp timestamptz := now() + interval '10 minutes';
  esc text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_kind IN ('landlord_payout_exception', 'landlord_float_withdrawal') THEN
    IF NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  ELSIF p_kind = 'rent_disbursement_exception' THEN
    IF NOT (public.is_cfo_approver(v_uid) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown kind of exception.';
  END IF;
  IF p_target_ids IS NULL OR cardinality(p_target_ids) = 0 THEN RAISE EXCEPTION 'Choose what to allow first.'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 THEN RAISE EXCEPTION 'Give the reason for the exception first (at least 10 characters).'; END IF;
  IF char_length(v_reason) > 600 THEN RAISE EXCEPTION 'The reason is too long (600 characters at most).'; END IF;
  IF (SELECT count(*) FROM public.exception_approval_codes WHERE requested_by = v_uid AND created_at > now() - interval '1 hour') >= 6 THEN
    RAISE EXCEPTION 'Too many codes requested. Try again in an hour.';
  END IF;

  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_target_ids) x;
  SELECT COALESCE(full_name, 'A staff member') INTO v_who FROM public.profiles WHERE id = v_uid;

  -- What the code approves, in words, for the email.
  IF p_kind = 'landlord_payout_exception' THEN
    SELECT string_agg(pa.full_name || ' (landlord ' || COALESCE(lp.landlord_name, w.mobile_money_name, '?') || ', UGX ' || to_char(w.amount, 'FM999,999,999,999')
                      || ', collected ' || COALESCE(r.rate_pct::text, 'n/a') || '% over 7 days)', E'\n' ORDER BY w.created_at)
      INTO v_what
      FROM public.withdrawal_requests w
      LEFT JOIN public.profiles pa ON pa.id = w.user_id
      LEFT JOIN public.landlord_payouts lp ON lp.id = w.landlord_payout_id
      LEFT JOIN LATERAL public.agent_collection_rate_7d(w.user_id) r ON true
     WHERE w.id = ANY (v_ids);
    v_label := 'Allow landlord payouts for agents under 50% (exception)';
  ELSIF p_kind = 'landlord_float_withdrawal' THEN
    SELECT string_agg(p.full_name || ' (collected ' || COALESCE(r.rate_pct::text, 'n/a') || '%, ' || COALESCE(r.basis, '') || ')', E'\n')
      INTO v_what
      FROM public.profiles p LEFT JOIN LATERAL public.agent_payout_collection_rate(p.id) r ON true
     WHERE p.id = ANY (v_ids);
    v_label := 'Let an agent under 50% withdraw landlord float this week (exception)';
  ELSE
    SELECT string_agg(pa.full_name || ' (rent UGX ' || to_char(rr.rent_amount, 'FM999,999,999,999') || ', collected ' || COALESCE(r.rate_pct::text, 'n/a') || '% over 7 days)', E'\n')
      INTO v_what
      FROM public.rent_requests rr
      LEFT JOIN public.profiles pa ON pa.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
      LEFT JOIN LATERAL public.agent_collection_rate_7d(COALESCE(rr.assigned_agent_id, rr.agent_id)) r ON true
     WHERE rr.id = ANY (v_ids);
    v_label := 'Fund rent to an agent under 50% (exception)';
  END IF;

  SELECT COALESCE(NULLIF(btrim(c.value), ''), 'joshua.wanda@welile.com') INTO v_to FROM public.treasury_controls c WHERE c.control_key = 'exception_approver_email';
  v_to := COALESCE(v_to, 'joshua.wanda@welile.com');

  -- Only the latest code for this person works.
  UPDATE public.exception_approval_codes SET consumed_at = now(), failure_reason = 'superseded' WHERE requested_by = v_uid AND consumed_at IS NULL;
  INSERT INTO public.exception_approval_codes (id, kind, requested_by, fingerprint, code_hash, approver_email, expires_at)
  VALUES (v_id, p_kind, v_uid, public.exception_otp_fingerprint(p_kind, v_ids, v_reason),
          encode(sha256(convert_to(v_code || ':' || v_id::text, 'UTF8')), 'hex'), v_to, v_exp);

  esc := replace(replace(replace(COALESCE(v_reason, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  v_text := 'Approval code: ' || v_code || E'\n\n' || v_who || ' is asking to: ' || v_label || E'\n\n' || COALESCE(v_what, '') || E'\n\nReason given: ' || v_reason
            || E'\n\nThe code works once, for exactly this request, for 10 minutes. If you did not expect this request, do not share the code.';
  v_html := '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fff">'
         || '<h2 style="margin:0 0 12px;color:#0f172a">Approval code</h2>'
         || '<p style="color:#334155;font-size:15px"><strong>' || replace(replace(v_who, '&', '&amp;'), '<', '&lt;') || '</strong> is asking to:<br><strong>' || v_label || '</strong></p>'
         || '<pre style="background:#f1f5f9;padding:12px;border-radius:8px;font-size:13px;white-space:pre-wrap">' || replace(replace(replace(COALESCE(v_what, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</pre>'
         || '<p style="color:#334155;font-size:14px"><strong>Reason given:</strong> ' || esc || '</p>'
         || '<p style="font-size:32px;letter-spacing:8px;font-weight:700;text-align:center;background:#f3eafd;color:#4c158d;border-radius:12px;padding:16px;margin:20px 0">' || v_code || '</p>'
         || '<p style="color:#64748b;font-size:12px">The code works once, for exactly this request, for 10 minutes. If you did not expect this request, do not share the code.</p>'
         || '<p style="color:#94a3b8;font-size:11px">Welile</p></div>';

  PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
    'message_id', gen_random_uuid()::text,
    'to', v_to,
    'from', 'Welile <noreply@welile.com>',
    'sender_domain', 'notify.welile.com',
    'subject', 'Approval code ' || v_code || ' to allow an exception',
    'html', v_html,
    'text', v_text,
    'purpose', 'transactional',
    'label', 'exception-approval-code',
    'idempotency_key', 'exception-otp:' || v_id::text,
    'queued_at', now()
  ));

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_uid, 'exception_approval_code_requested', 'Asked for an approval code to allow an exception', 'exception_approval_codes', v_id::text,
          jsonb_build_object('kind', p_kind, 'ids', v_ids, 'sent_to', v_to, 'reason', v_reason));

  RETURN jsonb_build_object('challenge_id', v_id, 'expires_at', v_exp, 'sent_to', regexp_replace(v_to, '^(.).*(@.*)$', '\1***\2'));
END;
$function$;

-- Step 2: check the code. Never raises on a wrong code, so the count of tries is kept.
CREATE OR REPLACE FUNCTION public.verify_exception_otp(p_kind text, p_target_ids uuid[], p_reason text, p_otp text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ch public.exception_approval_codes%ROWTYPE;
  v_fp text;
  v_code text := regexp_replace(COALESCE(p_otp, ''), '\s', '', 'g');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  v_fp := public.exception_otp_fingerprint(p_kind, p_target_ids, p_reason);

  SELECT * INTO v_ch FROM public.exception_approval_codes
   WHERE requested_by = v_uid AND consumed_at IS NULL AND fingerprint = v_fp AND kind = p_kind
   ORDER BY created_at DESC LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('verified', false, 'message', 'No code was requested for exactly these items and this reason. Ask for a new code.');
  END IF;
  IF v_ch.expires_at <= now() THEN
    RETURN jsonb_build_object('verified', false, 'message', 'That code has expired. Ask for a new one.');
  END IF;
  IF v_ch.verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('verified', true, 'message', 'Already approved. Go ahead.');
  END IF;
  IF v_ch.attempts >= v_ch.max_attempts THEN
    UPDATE public.exception_approval_codes SET consumed_at = now(), failure_reason = 'too_many_attempts' WHERE id = v_ch.id;
    RETURN jsonb_build_object('verified', false, 'message', 'Too many wrong codes. Ask for a new code.');
  END IF;
  IF v_code !~ '^[0-9]{6}$' OR encode(sha256(convert_to(v_code || ':' || v_ch.id::text, 'UTF8')), 'hex') <> v_ch.code_hash THEN
    UPDATE public.exception_approval_codes SET attempts = attempts + 1 WHERE id = v_ch.id;
    RETURN jsonb_build_object('verified', false, 'attempts_left', GREATEST(v_ch.max_attempts - v_ch.attempts - 1, 0),
                              'message', CASE WHEN v_ch.max_attempts - v_ch.attempts - 1 <= 0 THEN 'Wrong code. No tries left: ask for a new code.'
                                              ELSE 'Wrong code. ' || (v_ch.max_attempts - v_ch.attempts - 1) || ' tries left.' END);
  END IF;
  UPDATE public.exception_approval_codes SET verified_at = now() WHERE id = v_ch.id;
  RETURN jsonb_build_object('verified', true, 'message', 'Approved. You can allow the exception now (for the next ' ||
                            greatest(1, ceil(extract(epoch FROM (v_ch.expires_at - now())) / 60))::int || ' minutes).');
END;
$function$;

-- Step 3 (used by the exception functions): there must be a verified, unused, unexpired approval for exactly this request. It is used up here.
CREATE OR REPLACE FUNCTION public.use_verified_exception_approval(p_kind text, p_target_ids uuid[], p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_to text;
BEGIN
  SELECT id, approver_email INTO v_id, v_to FROM public.exception_approval_codes
   WHERE requested_by = v_uid AND kind = p_kind AND fingerprint = public.exception_otp_fingerprint(p_kind, p_target_ids, p_reason)
     AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1
   FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Approval needed: ask for a code (it is emailed to the approver), enter it, and then allow the exception. The code only works for these exact items and this reason, once, within 10 minutes.'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.exception_approval_codes SET consumed_at = now() WHERE id = v_id;
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_uid, 'exception_approved_by_code', 'An exception was allowed with the approver''s code', 'exception_approval_codes', v_id::text,
          jsonb_build_object('kind', p_kind, 'ids', p_target_ids, 'approver_email', v_to));
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_exception_otp(text, uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.verify_exception_otp(text, uuid[], text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.use_verified_exception_approval(text, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_exception_otp(text, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_exception_otp(text, uuid[], text, text) TO authenticated;

-- The three exception functions: keep the originals as *_unchecked (not callable by the app) and put checking wrappers under the old names.
DO $wrap$
BEGIN
  IF to_regprocedure('public.allow_landlord_payouts_with_exception_unchecked(uuid[],text)') IS NULL THEN
    ALTER FUNCTION public.allow_landlord_payouts_with_exception(uuid[], text) RENAME TO allow_landlord_payouts_with_exception_unchecked;
  END IF;
  IF to_regprocedure('public.allow_agent_landlord_float_withdrawal_unchecked(uuid,text)') IS NULL THEN
    ALTER FUNCTION public.allow_agent_landlord_float_withdrawal(uuid, text) RENAME TO allow_agent_landlord_float_withdrawal_unchecked;
  END IF;
  IF to_regprocedure('public.cfo_allow_rent_disbursement_exception_unchecked(uuid[],text)') IS NULL THEN
    ALTER FUNCTION public.cfo_allow_rent_disbursement_exception(uuid[], text) RENAME TO cfo_allow_rent_disbursement_exception_unchecked;
  END IF;
END
$wrap$;

REVOKE ALL ON FUNCTION public.allow_landlord_payouts_with_exception_unchecked(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.allow_agent_landlord_float_withdrawal_unchecked(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cfo_allow_rent_disbursement_exception_unchecked(uuid[], text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.allow_landlord_payouts_with_exception(p_withdrawal_ids uuid[], p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_exception_approval('landlord_payout_exception', p_withdrawal_ids, p_reason);
  RETURN public.allow_landlord_payouts_with_exception_unchecked(p_withdrawal_ids, p_reason);
END;
$function$;

CREATE OR REPLACE FUNCTION public.allow_agent_landlord_float_withdrawal(p_agent_id uuid, p_reason text)
RETURNS date LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_exception_approval('landlord_float_withdrawal', ARRAY[p_agent_id], p_reason);
  RETURN public.allow_agent_landlord_float_withdrawal_unchecked(p_agent_id, p_reason);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_allow_rent_disbursement_exception(p_rent_request_ids uuid[], p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_exception_approval('rent_disbursement_exception', p_rent_request_ids, p_reason);
  RETURN public.cfo_allow_rent_disbursement_exception_unchecked(p_rent_request_ids, p_reason);
END;
$function$;

REVOKE ALL ON FUNCTION public.allow_landlord_payouts_with_exception(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.allow_agent_landlord_float_withdrawal(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_allow_rent_disbursement_exception(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.allow_landlord_payouts_with_exception(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allow_agent_landlord_float_withdrawal(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_allow_rent_disbursement_exception(uuid[], text) TO authenticated;
