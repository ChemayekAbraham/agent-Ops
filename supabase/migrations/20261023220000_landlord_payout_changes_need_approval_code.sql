-- Every change to landlord payouts in CTO > Platform Controls now needs the emailed approval code, the same one "Allow with exception" already
-- needs (20261023150000). A screen that does not ask for the code, which is every screen today (the web app and the Android app), is REFUSED
-- by the database with "Approval needed: ...". That is the intent: the old web app breaks on these actions until it is changed.
--
-- WHAT NOW NEEDS A CODE (besides Allow with exception, already covered):
--   landlord_payout_block_change   Allow selected payouts through the block / block them again   set_landlord_payout_block_exemption(ids, allow)
--   landlord_payout_budget_change  Set, change or remove the payout goal                          set_landlord_payout_budget(budget, restart)
--   landlord_payouts_switch        Turn "Block landlord payouts from queue" ON or OFF            update of treasury_controls.landlord_payouts_blocked
-- NOT covered: Reject with message (it only hides payouts and tells the agent why; it cannot release money).
--
-- HOW A SCREEN GETS APPROVED (three calls, as for exceptions):
--   1. request_landlord_payout_change_otp(kind, ids, detail, reason)   emails the code to the approver (exception_approver_email)
--   2. verify_exception_otp(kind, ids, reason, otp)                    existing function; 5 tries, 10 minutes
--   3. the change itself, within 10 minutes. The code is bound to the person, the kind, the ids and the DETAIL, and works once.
--      detail: block change -> 'allow' or 'block'; budget -> 'budget=<whole number or none>|restart=<true|false>'; switch -> 'on' or 'off'.
--      ids: the withdrawal ids; for the budget use 00000000-0000-0000-0000-000000000001; for the switch use the control row id.
-- Changes made from the SQL editor or by a migration (no signed-in user) are not blocked, so the CTO can always fix things from the database.
-- Needs 20261023150000_exception_approval_otp.sql. Roll back with 20261023220000_landlord_payout_changes_need_approval_code.rollback.sql.

ALTER TABLE public.exception_approval_codes ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT '';
ALTER TABLE public.exception_approval_codes ADD COLUMN IF NOT EXISTS scope_fp text;
ALTER TABLE public.exception_approval_codes DROP CONSTRAINT IF EXISTS exception_approval_codes_kind_check;
ALTER TABLE public.exception_approval_codes ADD CONSTRAINT exception_approval_codes_kind_check CHECK (kind IN (
  'landlord_payout_exception', 'landlord_float_withdrawal', 'rent_disbursement_exception',
  'landlord_payout_block_change', 'landlord_payout_budget_change', 'landlord_payouts_switch'));

CREATE OR REPLACE FUNCTION public.exception_otp_scope(p_kind text, p_ids uuid[], p_detail text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT encode(sha256(convert_to('scope:' || p_kind || ':' || COALESCE((SELECT string_agg(x::text, ',' ORDER BY x) FROM (SELECT DISTINCT unnest(p_ids) AS x) d), '')
                                  || ':' || COALESCE(p_detail, ''), 'UTF8')), 'hex');
$function$;

-- Step 1: email the code.
CREATE OR REPLACE FUNCTION public.request_landlord_payout_change_otp(p_kind text, p_target_ids uuid[], p_detail text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ids uuid[]; v_id uuid := gen_random_uuid();
  v_code text := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  v_to text; v_who text; v_what text := ''; v_label text; v_text text; v_html text; v_exp timestamptz := now() + interval '10 minutes';
BEGIN
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('landlord_payout_block_change', 'landlord_payout_budget_change', 'landlord_payouts_switch') THEN RAISE EXCEPTION 'Unknown kind of change.'; END IF;
  IF p_target_ids IS NULL OR cardinality(p_target_ids) = 0 THEN RAISE EXCEPTION 'Choose what to change first.'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 THEN RAISE EXCEPTION 'Give the reason first (at least 10 characters).'; END IF;
  IF (SELECT count(*) FROM public.exception_approval_codes WHERE requested_by = v_uid AND created_at > now() - interval '1 hour') >= 6 THEN
    RAISE EXCEPTION 'Too many codes requested. Try again in an hour.';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_target_ids) x;
  SELECT COALESCE(full_name, 'A staff member') INTO v_who FROM public.profiles WHERE id = v_uid;

  IF p_kind = 'landlord_payout_block_change' THEN
    v_label := CASE WHEN p_detail = 'allow' THEN 'Allow selected landlord payouts through the block' ELSE 'Block selected landlord payouts again' END;
    SELECT string_agg(COALESCE(pa.full_name, '?') || ' UGX ' || to_char(w.amount, 'FM999,999,999,999'), E'\n' ORDER BY w.created_at) INTO v_what
      FROM public.withdrawal_requests w LEFT JOIN public.profiles pa ON pa.id = w.user_id WHERE w.id = ANY (v_ids);
  ELSIF p_kind = 'landlord_payout_budget_change' THEN
    v_label := 'Change the landlord payout goal'; v_what := COALESCE(p_detail, '');
  ELSE
    v_label := 'Turn "Block landlord payouts from queue" ' || upper(COALESCE(p_detail, '?'));
  END IF;

  SELECT COALESCE(NULLIF(btrim(c.value), ''), 'joshua.wanda@welile.com') INTO v_to FROM public.treasury_controls c WHERE c.control_key = 'exception_approver_email';
  v_to := COALESCE(v_to, 'joshua.wanda@welile.com');

  UPDATE public.exception_approval_codes SET consumed_at = now(), failure_reason = 'superseded' WHERE requested_by = v_uid AND consumed_at IS NULL;
  INSERT INTO public.exception_approval_codes (id, kind, requested_by, fingerprint, code_hash, approver_email, expires_at, detail, scope_fp)
  VALUES (v_id, p_kind, v_uid, public.exception_otp_fingerprint(p_kind, v_ids, v_reason), encode(sha256(convert_to(v_code || ':' || v_id::text, 'UTF8')), 'hex'),
          v_to, v_exp, COALESCE(p_detail, ''), public.exception_otp_scope(p_kind, v_ids, p_detail));

  v_text := 'Approval code: ' || v_code || E'\n\n' || v_who || ' is asking to: ' || v_label || E'\n\n' || COALESCE(v_what, '') || E'\n\nReason given: ' || v_reason
            || E'\n\nThe code works once, for exactly this change, for 10 minutes. If you did not expect this, do not share it.';
  v_html := '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px"><h2 style="margin:0 0 12px">Approval code</h2>'
         || '<p><strong>' || replace(replace(v_who, '&', '&amp;'), '<', '&lt;') || '</strong> is asking to:<br><strong>' || replace(replace(v_label, '&', '&amp;'), '<', '&lt;') || '</strong></p>'
         || '<pre style="background:#f1f5f9;padding:12px;border-radius:8px;white-space:pre-wrap">' || replace(replace(replace(COALESCE(v_what, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</pre>'
         || '<p><strong>Reason given:</strong> ' || replace(replace(replace(v_reason, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>'
         || '<p style="font-size:32px;letter-spacing:8px;font-weight:700;text-align:center;background:#f3eafd;color:#4c158d;border-radius:12px;padding:16px">' || v_code || '</p>'
         || '<p style="color:#64748b;font-size:12px">The code works once, for exactly this change, for 10 minutes. If you did not expect this, do not share it.</p></div>';
  PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
    'message_id', gen_random_uuid()::text, 'to', v_to, 'from', 'Welile <noreply@welile.com>', 'sender_domain', 'notify.welile.com',
    'subject', 'Approval code ' || v_code || ' for a landlord payout change', 'html', v_html, 'text', v_text, 'purpose', 'transactional',
    'label', 'landlord-payout-change-code', 'idempotency_key', 'lp-change-otp:' || v_id::text, 'queued_at', now()));
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_uid, 'exception_approval_code_requested', 'Asked for an approval code for a landlord payout change', 'exception_approval_codes', v_id::text,
          jsonb_build_object('kind', p_kind, 'ids', v_ids, 'detail', p_detail, 'sent_to', v_to, 'reason', v_reason));
  RETURN jsonb_build_object('challenge_id', v_id, 'expires_at', v_exp, 'sent_to', regexp_replace(v_to, '^(.).*(@.*)$', '\1***\2'));
END;
$function$;

-- Step 3 helper: a verified, unused, unexpired code for exactly this kind + ids + detail. Used up here.
CREATE OR REPLACE FUNCTION public.use_verified_scope_approval(p_kind text, p_ids uuid[], p_detail text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.exception_approval_codes
   WHERE requested_by = auth.uid() AND kind = p_kind AND scope_fp = public.exception_otp_scope(p_kind, p_ids, p_detail)
     AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Approval needed: ask for a code (it is emailed to the approver), enter it, and then make the change. The code only works for this exact change, once, within 10 minutes.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.exception_approval_codes SET consumed_at = now() WHERE id = v_id;
  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (auth.uid(), 'landlord_payout_change_approved_by_code', 'A landlord payout change was made with the approver''s code', 'exception_approval_codes', v_id::text,
          jsonb_build_object('kind', p_kind, 'ids', p_ids, 'detail', p_detail));
  RETURN v_id;
END;
$function$;

-- The two panel functions: originals become *_unchecked (closed to the app); wrappers keep the old names and arguments.
DO $wrap$
BEGIN
  IF to_regprocedure('public.set_landlord_payout_block_exemption_unchecked(uuid[],boolean)') IS NULL THEN
    ALTER FUNCTION public.set_landlord_payout_block_exemption(uuid[], boolean) RENAME TO set_landlord_payout_block_exemption_unchecked;
  END IF;
  IF to_regprocedure('public.set_landlord_payout_budget_unchecked(numeric,boolean)') IS NULL THEN
    ALTER FUNCTION public.set_landlord_payout_budget(numeric, boolean) RENAME TO set_landlord_payout_budget_unchecked;
  END IF;
END
$wrap$;

CREATE OR REPLACE FUNCTION public.set_landlord_payout_block_exemption(p_withdrawal_ids uuid[], p_allow boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_scope_approval('landlord_payout_block_change', p_withdrawal_ids, CASE WHEN p_allow THEN 'allow' ELSE 'block' END);
  RETURN public.set_landlord_payout_block_exemption_unchecked(p_withdrawal_ids, p_allow);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_landlord_payout_budget(p_budget numeric, p_restart boolean DEFAULT false)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.use_verified_scope_approval('landlord_payout_budget_change', ARRAY['00000000-0000-0000-0000-000000000001'::uuid],
    'budget=' || COALESCE(trunc(NULLIF(p_budget, 0))::text, 'none') || '|restart=' || COALESCE(p_restart, false)::text);
  RETURN public.set_landlord_payout_budget_unchecked(p_budget, p_restart);
END;
$function$;

-- The switch: any signed-in change of the flag needs the code (works for the web's direct table update and for the Android app alike).
CREATE OR REPLACE FUNCTION public.guard_landlord_payouts_switch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.control_key = 'landlord_payouts_blocked' AND NEW.enabled IS DISTINCT FROM OLD.enabled AND auth.uid() IS NOT NULL THEN
    PERFORM public.use_verified_scope_approval('landlord_payouts_switch', ARRAY[NEW.id], CASE WHEN NEW.enabled THEN 'on' ELSE 'off' END);
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_guard_landlord_payouts_switch ON public.treasury_controls;
CREATE TRIGGER trg_guard_landlord_payouts_switch BEFORE UPDATE ON public.treasury_controls FOR EACH ROW EXECUTE FUNCTION public.guard_landlord_payouts_switch();

REVOKE ALL ON FUNCTION public.set_landlord_payout_block_exemption_unchecked(uuid[], boolean), public.set_landlord_payout_budget_unchecked(numeric, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.use_verified_scope_approval(text, uuid[], text), public.guard_landlord_payouts_switch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_landlord_payout_block_exemption(uuid[], boolean), public.set_landlord_payout_budget(numeric, boolean), public.request_landlord_payout_change_otp(text, uuid[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_landlord_payout_block_exemption(uuid[], boolean), public.set_landlord_payout_budget(numeric, boolean), public.request_landlord_payout_change_otp(text, uuid[], text, text) TO authenticated;
