-- OTP usage by category (login, withdraw, landlord payout, signup, phone
-- update, phone collection, payout-number confirmation, National ID link
-- consent, Welile Homes tenant verification, password reset) -- Josh asked
-- for an end-of-day breakdown of OTP usage everywhere OTP applies.
--
-- Every OTP flow in this codebase was audited (docs/HANDOVER/82) before
-- writing this. Two categories already have a fully isolated, per-attempt
-- audit trail and need no new instrumentation:
--   - login verification -> otp_login_audit (otp-login edge function)
--   - wallet withdrawal   -> wallet_withdrawal_otp_challenges/_events
--   - landlord payout     -> landlord_payout_otp_challenges/_events
-- Everything else (signup, phone update/collection, payout-number
-- confirmation, National ID link consent, Welile Homes tenant verification,
-- password reset) shares the generic `sms-otp` send/verify actions and the
-- single `otp_verifications` table, which has no purpose/category column and
-- is upserted per-phone (one row, overwritten on every send) -- there was
-- previously no way to attribute a send or verify to a category at all.
--
-- otp_usage_events is the new durable per-attempt log those generic flows
-- now write to (edge function changes in the same commit). login's SEND side
-- also writes here (category='login') since otp_login_audit only covers the
-- verify step; login's verify numbers keep coming from otp_login_audit,
-- which is more complete (it already existed and gets no new event rows).

CREATE TABLE public.otp_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('sent', 'send_failed', 'verify_success', 'verify_failed')),
  phone text,
  source_function text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_usage_events_created_at_category ON public.otp_usage_events (created_at, category);

ALTER TABLE public.otp_usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_otp_usage_events" ON public.otp_usage_events
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "privileged_read_otp_usage_events" ON public.otp_usage_events
  FOR SELECT USING (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
  );

CREATE FUNCTION public.get_otp_usage_by_category(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := (p_date::text || ' 00:00:00+03')::timestamptz;
  v_end   timestamptz := (p_date::text || ' 23:59:59.999+03')::timestamptz;
  v jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH generic AS (
    -- signup, phone_update, phone_collection, payout_number,
    -- national_id_link, welile_homes_tenant_verify, password_reset (verify
    -- only -- its sends are logged separately below), and login's send side.
    SELECT category,
           count(*) FILTER (WHERE event_type = 'sent') AS sent,
           count(*) FILTER (WHERE event_type = 'send_failed') AS send_failed,
           count(*) FILTER (WHERE event_type = 'verify_success') AS verify_success,
           count(*) FILTER (WHERE event_type = 'verify_failed') AS verify_failed
    FROM public.otp_usage_events
    WHERE created_at BETWEEN v_start AND v_end
    GROUP BY category
  ),
  login_verify AS (
    -- otp_login_audit predates this table and already covers every login
    -- verify attempt in full -- not folded into otp_usage_events to avoid a
    -- second, potentially-drifting copy of the same data.
    SELECT 'login'::text AS category,
           0 AS sent, 0 AS send_failed,
           count(*) FILTER (WHERE outcome = 'success') AS verify_success,
           count(*) FILTER (WHERE outcome <> 'success') AS verify_failed
    FROM public.otp_login_audit
    WHERE created_at BETWEEN v_start AND v_end
  ),
  wallet_withdrawal_sent AS (
    SELECT 'wallet_withdrawal'::text AS category,
           count(*) AS sent, 0 AS send_failed, 0 AS verify_success, 0 AS verify_failed
    FROM public.wallet_withdrawal_otp_challenges
    WHERE created_at BETWEEN v_start AND v_end
  ),
  wallet_withdrawal_verify AS (
    -- event_type values observed live: sent, resent, verified, failed,
    -- incorrect_attempt, submitted, submit_rejected, already_verified.
    -- 'incorrect_attempt' is the actual wrong-code signal -- 'failed' alone
    -- undercounts by ~10x.
    SELECT 'wallet_withdrawal'::text AS category,
           0 AS sent, 0 AS send_failed,
           count(*) FILTER (WHERE event_type = 'verified') AS verify_success,
           count(*) FILTER (WHERE event_type IN ('failed', 'incorrect_attempt')) AS verify_failed
    FROM public.wallet_withdrawal_otp_events
    WHERE created_at BETWEEN v_start AND v_end
  ),
  landlord_payout_sent AS (
    SELECT 'landlord_payout'::text AS category,
           count(*) AS sent, 0 AS send_failed, 0 AS verify_success, 0 AS verify_failed
    FROM public.landlord_payout_otp_challenges
    WHERE created_at BETWEEN v_start AND v_end
  ),
  landlord_payout_verify AS (
    SELECT 'landlord_payout'::text AS category,
           0 AS sent, 0 AS send_failed,
           count(*) FILTER (WHERE event_type = 'verified') AS verify_success,
           count(*) FILTER (WHERE event_type IN ('failed', 'incorrect_attempt')) AS verify_failed
    FROM public.landlord_payout_otp_events
    WHERE created_at BETWEEN v_start AND v_end
  ),
  password_reset_sent AS (
    -- password-reset-sms sends its own SMS directly (not via sms-otp) and
    -- already tags sms_delivery_log with a distinct source -- read that
    -- rather than duplicating a second write path for the send side.
    SELECT 'password_reset'::text AS category,
           count(*) FILTER (WHERE status IN ('sent', 'accepted', 'delivered')) AS sent,
           count(*) FILTER (WHERE status = 'failed') AS send_failed,
           0 AS verify_success, 0 AS verify_failed
    FROM public.sms_delivery_log
    WHERE source = 'password-reset-sms' AND created_at BETWEEN v_start AND v_end
  ),
  combined AS (
    SELECT * FROM generic
    UNION ALL SELECT * FROM login_verify
    UNION ALL SELECT * FROM wallet_withdrawal_sent
    UNION ALL SELECT * FROM wallet_withdrawal_verify
    UNION ALL SELECT * FROM landlord_payout_sent
    UNION ALL SELECT * FROM landlord_payout_verify
    UNION ALL SELECT * FROM password_reset_sent
  ),
  rolled_up AS (
    SELECT category,
           sum(sent)::bigint AS sent,
           sum(send_failed)::bigint AS send_failed,
           sum(verify_success)::bigint AS verify_success,
           sum(verify_failed)::bigint AS verify_failed
    FROM combined
    GROUP BY category
  )
  SELECT jsonb_build_object(
    'date', p_date,
    'generated_at', now(),
    'by_category', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'category', category,
        'sent', sent,
        'send_failed', send_failed,
        'verify_success', verify_success,
        'verify_failed', verify_failed
      ) ORDER BY (sent + verify_success + verify_failed) DESC)
      FROM rolled_up
    ), '[]'::jsonb),
    'totals', (
      SELECT jsonb_build_object(
        'sent', COALESCE(sum(sent), 0),
        'send_failed', COALESCE(sum(send_failed), 0),
        'verify_success', COALESCE(sum(verify_success), 0),
        'verify_failed', COALESCE(sum(verify_failed), 0)
      ) FROM rolled_up
    )
  ) INTO v;

  RETURN v;
END;
$function$;

-- Same drift-detection coverage as the rest of the CTO report pipeline
-- (docs/HANDOVER/17, 66) -- a silent revert of this function should surface
-- within 15 minutes, not at the next manual audit.
INSERT INTO public.critical_function_baselines (function_signature, expected_sha256, note, baselined_at, baselined_by)
SELECT 'get_otp_usage_by_category(date)',
       encode(sha256(convert_to(pg_get_functiondef('get_otp_usage_by_category(date)'::regprocedure), 'UTF8')), 'hex'),
       'Feeds the OTP-usage-by-category section of the daily CTO report. Rolls up otp_usage_events (generic sms-otp flows) with the pre-existing otp_login_audit / wallet_withdrawal_otp_* / landlord_payout_otp_* / sms_delivery_log tables per category.',
       now(),
       '20260918180000_otp_usage_by_category.sql'
ON CONFLICT (function_signature) DO UPDATE
  SET expected_sha256 = EXCLUDED.expected_sha256,
      baselined_at = now(),
      baselined_by = EXCLUDED.baselined_by,
      note = EXCLUDED.note;
