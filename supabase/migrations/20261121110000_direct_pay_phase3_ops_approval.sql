-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Self-support option 2 (the partner pays the landlord directly). Phase 3: Landlord Ops view, landlord OTP,
-- approve and reject. Needs 20261121090000 and 20261121100000. Still behind the switch self_support_direct_pay.
--
-- Approval is ONE transaction. It checks the landlord OTP the officer typed (wrong codes are counted even though
-- the call returns normally) and the call note. Then it:
--   * approves the proofs (a TID can be approved once, ever);
--   * builds the same records option 1 builds (commitment, funding line, portfolio, pending-portfolio link), active
--     at once, so Rent Profit Share, repayment allocation and the partner's screens work unchanged;
--   * posts the no-cash ledger group (A3 debit / L2 credit) and option 1's treasury fee recognition;
--   * takes the 2% Cover fee from the partner's operational float to their proxy agent (Welile keeps it when there
--     is none), and marks the portfolio's fund-in commission candidate not_commissionable so the proxy agent is
--     paid once;
--   * pays the tenant's agent 1% + UGX 5,000 with the same categories as the payout triggers (the bonus even
--     shares their idempotency key);
--   * issues the WLR receipt (landlord_payout_receipts; payout_id = the direct payment);
--   * sets the plan funded, then repaying from tomorrow.
--
-- Phase 0 found that a landlord_payouts row is refused by a locked check and would be read as cash out by about
-- 110 functions, so instead:
--   * gate_repaying_on_merchant_landlord_payout also accepts a confirmed direct payment (repaying would
--     otherwise be silently undone);
--   * _am_plan_clock_core counts a confirmed direct payment as the landlord payment that starts the Tenant Ops
--     clock;
--   * a new trigger refuses any later landlord payout for a plan paid directly.
-- Both edits append to the LIVE definition after an md5 check, and the originals are saved for the rollback.
-- REQUIRES THE OWNER'S YES before it is applied to production.

SET lock_timeout = '5s';

-- ---------------------------------------------------------------- 0. guards
DO $guard$
DECLARE
  v_names text[] := ARRAY['gate_repaying_on_merchant_landlord_payout', '_am_plan_clock_core', '_direct_pay_landlord_paid',
                          '_direct_pay_can_act', '_direct_pay_can_view', 'direct_pay_ops_queue', 'direct_pay_otp_authorize',
                          'direct_pay_otp_issue', 'direct_pay_otp_mark', 'direct_pay_approve', 'direct_pay_reject',
                          '_direct_pay_cover_charge', '_direct_pay_agent_pay', '_direct_pay_issue_receipt',
                          'trg_direct_pay_no_second_payout'];
BEGIN
  IF to_regprocedure('public.direct_pay_claim(uuid)') IS NULL OR to_regclass('public.direct_pay_saved_definitions') IS NULL THEN
    RAISE EXCEPTION 'direct pay phase 3: phase 2 (20261121100000) is not applied';
  END IF;
  IF to_regclass('public.protected_functions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.protected_functions WHERE func_name = ANY (v_names)) THEN
    RAISE EXCEPTION 'direct pay phase 3: a function this file replaces is protected (locked)';
  END IF;
END
$guard$;

INSERT INTO public.direct_pay_saved_definitions (object_name, definition)
VALUES ('function:gate_repaying_on_merchant_landlord_payout',
        pg_get_functiondef('public.gate_repaying_on_merchant_landlord_payout()'::regprocedure)),
       ('function:_am_plan_clock_core',
        pg_get_functiondef((SELECT oid FROM pg_proc WHERE proname = '_am_plan_clock_core' AND pronamespace = 'public'::regnamespace)))
ON CONFLICT (object_name) DO NOTHING;

-- ---------------------------------------------------------------- 1. landlord OTP challenges
CREATE TABLE IF NOT EXISTS public.direct_pay_landlord_otps (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       uuid        NOT NULL REFERENCES public.funder_offplatform_rent_payments (id) ON DELETE RESTRICT,
  staff_id         uuid        NOT NULL,
  recipient_phone  text        NOT NULL,
  otp_hash         text        NOT NULL,
  expires_at       timestamptz NOT NULL,
  attempts         smallint    NOT NULL DEFAULT 0,
  max_attempts     smallint    NOT NULL DEFAULT 3,
  status           text        NOT NULL DEFAULT 'issued',
  send_detail      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  verified_at      timestamptz,
  CONSTRAINT dp_otps_status CHECK (status IN ('issued', 'sent', 'send_failed', 'verified', 'locked', 'replaced'))
);
CREATE INDEX IF NOT EXISTS ix_dp_otps_payment ON public.direct_pay_landlord_otps (payment_id, created_at DESC);
ALTER TABLE public.direct_pay_landlord_otps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.direct_pay_landlord_otps;
CREATE POLICY mfa_required_for_staff ON public.direct_pay_landlord_otps AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
-- Hashes only, read and written by SECURITY DEFINER functions; nobody reads this table from the browser.
REVOKE ALL ON public.direct_pay_landlord_otps FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.direct_pay_landlord_otps TO service_role;

-- ---------------------------------------------------------------- 2. who may see / act
-- Only Landlord Ops call and decide. The COO (and super admin) see the same queue, read-only.
CREATE OR REPLACE FUNCTION public._direct_pay_can_act(p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_uid IS NOT NULL AND public.has_role(p_uid, 'landlord_ops'::public.app_role) AND public.staff_mfa_ok()
$$;
CREATE OR REPLACE FUNCTION public._direct_pay_can_view(p_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_uid IS NOT NULL AND public.staff_mfa_ok()
     AND (public.has_role(p_uid, 'landlord_ops'::public.app_role) OR public.has_role(p_uid, 'coo'::public.app_role)
          OR public.has_role(p_uid, 'super_admin'::public.app_role))
$$;
CREATE OR REPLACE FUNCTION public._direct_pay_landlord_paid(p_rent_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments dp
                  WHERE dp.rent_request_id = p_rent_request_id AND dp.flow = 'direct_pay' AND dp.status = 'confirmed')
$$;
REVOKE ALL ON FUNCTION public._direct_pay_can_act(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._direct_pay_can_view(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._direct_pay_landlord_paid(uuid) FROM PUBLIC, anon, authenticated;

-- Staff can open the proof photos (the app signs them in one batch per page).
DROP POLICY IF EXISTS direct_pay_staff_read_offplatform_receipt ON storage.objects;
CREATE POLICY direct_pay_staff_read_offplatform_receipt ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'funder-offplatform-receipts' AND public._direct_pay_can_view((SELECT auth.uid())));

-- ---------------------------------------------------------------- 3. live edits (md5-checked, originals saved)
DO $gate$
DECLARE
  v_def text := pg_get_functiondef('public.gate_repaying_on_merchant_landlord_payout()'::regprocedure);
  v_find constant text := 'OR public.rent_request_landlord_paid_by_merchant(NEW.id) THEN';
BEGIN
  IF v_def LIKE '%_direct_pay_landlord_paid%' THEN RETURN; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.gate_repaying_on_merchant_landlord_payout()'::regprocedure))
     <> 'cdc6280403933c935fb7865712b49df2' THEN
    RAISE EXCEPTION 'direct pay phase 3: gate_repaying_on_merchant_landlord_payout changed since 2026-11-13';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_find, ''))) / length(v_find) <> 1 THEN
    RAISE EXCEPTION 'direct pay phase 3: the gate''s landlord-paid test is not where it was';
  END IF;
  EXECUTE replace(v_def, v_find,
    'OR public.rent_request_landlord_paid_by_merchant(NEW.id) OR public._direct_pay_landlord_paid(NEW.id) THEN');
END
$gate$;

DO $clock$
DECLARE
  v_oid oid := (SELECT oid FROM pg_proc WHERE proname = '_am_plan_clock_core' AND pronamespace = 'public'::regnamespace);
  v_def text := pg_get_functiondef(v_oid);
  v_pat constant text := '(AND lp\.status IN \(''awaiting_agent_receipt'', ''completed''\))(\s*\) d)';
BEGIN
  IF v_def LIKE '%funder_offplatform_rent_payments%' THEN RETURN; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'f9ed7419c3e9fbe39844034ab8e7ffff' THEN
    RAISE EXCEPTION 'direct pay phase 3: _am_plan_clock_core changed since 2026-11-13';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, v_pat, 'g')) <> 1 THEN
    RAISE EXCEPTION 'direct pay phase 3: the clock''s landlord payout filter is not where it was';
  END IF;
  -- A confirmed direct payment counts like a paid landlord payout: the clock starts the day after it.
  EXECUTE regexp_replace(v_def, v_pat,
    '\1
        UNION ALL
        SELECT dp.rent_request_id, dp.amount, false,
               (dp.confirmed_at AT TIME ZONE ''Africa/Kampala'')::date
          FROM public.funder_offplatform_rent_payments dp
         WHERE dp.rent_request_id IN (SELECT id FROM ids)
           AND dp.flow = ''direct_pay'' AND dp.status = ''confirmed''\2');
END
$clock$;

-- ---------------------------------------------------------------- 4. no second landlord payment for a plan paid directly
CREATE OR REPLACE FUNCTION public.trg_direct_pay_no_second_payout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.rent_request_id IS NOT NULL AND public._direct_pay_landlord_paid(NEW.rent_request_id) THEN
    RAISE EXCEPTION 'DIRECT_PAY_LANDLORD_PAID: the partner already paid this landlord directly for this Rent Plan. Do not pay the landlord.'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.trg_direct_pay_no_second_payout() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS aa_00_direct_pay_no_second_payout ON public.landlord_payouts;
CREATE TRIGGER aa_00_direct_pay_no_second_payout BEFORE INSERT ON public.landlord_payouts
  FOR EACH ROW EXECUTE FUNCTION public.trg_direct_pay_no_second_payout();

-- ---------------------------------------------------------------- 5. the queue (one query, keyset paged)
-- p_view: 'pending' (default; flagged first, then oldest) or 'decided' (latest confirmed / rejected first).
-- Next page: pass the last row's (has_flags, created_at, id) for 'pending', or (decided_at, id) for 'decided'.
CREATE OR REPLACE FUNCTION public.direct_pay_ops_queue(
  p_view text DEFAULT 'pending', p_after_flagged boolean DEFAULT NULL, p_after_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lim int := GREATEST(1, LEAST(COALESCE(p_limit, 30), 100));
BEGIN
  IF NOT public._direct_pay_can_view(v_uid) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'can_act', public._direct_pay_can_act(v_uid),
    'rows', COALESCE((
      SELECT jsonb_agg(row_json ORDER BY ord1 DESC, ord2, ord3) FROM (
        SELECT CASE WHEN p_view = 'decided' THEN 0 ELSE (cardinality(p.flags) > 0)::int END AS ord1,
               CASE WHEN p_view = 'decided' THEN -extract(epoch FROM COALESCE(p.confirmed_at, p.rejected_at))
                    ELSE extract(epoch FROM p.created_at) END AS ord2,
               p.id AS ord3,
               jsonb_build_object(
                 'payment_id', p.id, 'status', p.status, 'created_at', p.created_at,
                 'has_flags', cardinality(p.flags) > 0, 'flags', p.flags,
                 'waiting_hours', round(extract(epoch FROM now() - p.created_at) / 3600, 1),
                 'over_24h', p.status = 'pending' AND p.created_at < now() - interval '24 hours',
                 'decided_at', COALESCE(p.confirmed_at, p.rejected_at),
                 'rent_request_id', p.rent_request_id, 'amount_due', p.amount, 'amount_received', p.amount_received,
                 'cover_fee', p.cover_fee_amount, 'cover_fee_status', p.cover_fee_status,
                 'partner', jsonb_build_object('id', p.funder_id, 'name', pf.full_name, 'phone', pf.phone),
                 'tenant', jsonb_build_object('name', tp.full_name, 'phone', tp.phone),
                 'agent', jsonb_build_object('id', p.agent_id, 'name', ap.full_name, 'phone', ap.phone),
                 'landlord', jsonb_build_object('name', ld.name, 'phone_on_file', ld.phone, 'verified_number', p.landlord_phone),
                 'call_note', p.call_note, 'flag_reason', p.flag_reason, 'reject_note', p.reject_note,
                 'otp', (SELECT jsonb_build_object('status', o.status, 'sent_at', o.created_at, 'expires_at', o.expires_at,
                                                   'attempts_left', GREATEST(0, o.max_attempts - o.attempts))
                           FROM public.direct_pay_landlord_otps o WHERE o.payment_id = p.id
                          ORDER BY o.created_at DESC LIMIT 1),
                 'proofs', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                             'id', f.id, 'photo_path', f.photo_path, 'provider', f.provider,
                             'amount_read', f.amount_read, 'amount_typed', f.amount_typed,
                             'tid_read', f.tid_read, 'tid_typed', f.tid_typed,
                             'recipient_read', f.recipient_read, 'paid_at_read', f.paid_at_read,
                             'reader_status', f.reader_status, 'created_at', f.created_at) ORDER BY f.created_at)
                               FROM public.funder_offplatform_rent_proofs f WHERE f.payment_id = p.id), '[]'::jsonb)
               ) AS row_json
          FROM public.funder_offplatform_rent_payments p
          LEFT JOIN public.profiles pf ON pf.id = p.funder_id
          LEFT JOIN public.rent_requests rr ON rr.id = p.rent_request_id
          LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
          LEFT JOIN public.profiles ap ON ap.id = p.agent_id
          LEFT JOIN public.landlords ld ON ld.id = p.landlord_id
         WHERE p.flow = 'direct_pay'
           AND CASE WHEN p_view = 'decided'
                    THEN p.status IN ('confirmed', 'rejected')
                         AND (p_after_at IS NULL
                              OR (COALESCE(p.confirmed_at, p.rejected_at), p.id) < (p_after_at, p_after_id))
                    ELSE p.status = 'pending'
                         AND (p_after_at IS NULL
                              OR ((cardinality(p.flags) > 0) = p_after_flagged AND (p.created_at, p.id) > (p_after_at, p_after_id))
                              OR ((cardinality(p.flags) > 0) = false AND p_after_flagged))
               END
         ORDER BY 1 DESC, 2, 3
         LIMIT v_lim) q), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_ops_queue(text, boolean, timestamptz, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_ops_queue(text, boolean, timestamptz, uuid, integer) TO authenticated;

-- ---------------------------------------------------------------- 6. landlord OTP
-- The edge function direct-pay-landlord-otp calls authorize WITH THE OFFICER'S TOKEN (role + MFA checked here),
-- then issue and mark with the service key. The code goes from issue to the SMS sender and nowhere else.
CREATE OR REPLACE FUNCTION public.direct_pay_otp_authorize(p_payment_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public._direct_pay_can_act(auth.uid()) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments
                  WHERE id = p_payment_id AND flow = 'direct_pay' AND status = 'pending') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending');
  END IF;
  RETURN jsonb_build_object('ok', true, 'staff_id', auth.uid());
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_otp_authorize(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_otp_authorize(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.direct_pay_otp_issue(p_staff uuid, p_payment_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE
  p public.funder_offplatform_rent_payments%ROWTYPE;
  v_code text;
  v_phone text;
  v_id uuid;
  v_ld record;
  v_tenant text;
BEGIN
  IF p_staff IS NULL OR NOT public.has_role(p_staff, 'landlord_ops'::public.app_role) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authorized');
  END IF;
  SELECT * INTO p FROM public.funder_offplatform_rent_payments
   WHERE id = p_payment_id AND flow = 'direct_pay' FOR UPDATE;
  IF NOT FOUND OR p.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_pending'); END IF;
  -- At most 5 codes an hour for one payment.
  IF (SELECT count(*) FROM public.direct_pay_landlord_otps
       WHERE payment_id = p.id AND created_at > now() - interval '1 hour') >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_many_codes');
  END IF;

  -- The phone on file first (the landlord's own contact), else the verified payout number.
  SELECT ld.name, NULLIF(btrim(ld.phone), '') AS phone INTO v_ld FROM public.landlords ld WHERE ld.id = p.landlord_id;
  v_phone := CASE WHEN length(COALESCE(public.landlord_number_norm(v_ld.phone), '')) >= 9 THEN v_ld.phone ELSE p.landlord_phone END;
  SELECT split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'the tenant'), ' ', 1) INTO v_tenant
    FROM public.rent_requests rr LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id WHERE rr.id = p.rent_request_id;

  UPDATE public.direct_pay_landlord_otps SET status = 'replaced'
   WHERE payment_id = p.id AND status IN ('issued', 'sent', 'send_failed');

  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');
  INSERT INTO public.direct_pay_landlord_otps (payment_id, staff_id, recipient_phone, otp_hash, expires_at)
  VALUES (p.id, p_staff, v_phone, encode(digest(v_code, 'sha256'), 'hex'), now() + interval '10 minutes')
  RETURNING id INTO v_id;
  UPDATE public.funder_offplatform_rent_payments SET landlord_otp_challenge_id = v_id WHERE id = p.id;

  RETURN jsonb_build_object('ok', true, 'challenge_id', v_id, 'otp', v_code, 'recipient_phone', v_phone,
                            'landlord_name', v_ld.name, 'tenant_first_name', v_tenant, 'amount', p.amount,
                            'expires_at', now() + interval '10 minutes');
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_otp_issue(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.direct_pay_otp_issue(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.direct_pay_otp_mark(p_challenge_id uuid, p_sent boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.direct_pay_landlord_otps
     SET status = CASE WHEN p_sent THEN 'sent' ELSE 'send_failed' END, send_detail = left(p_detail, 300)
   WHERE id = p_challenge_id AND status = 'issued';
$$;
REVOKE ALL ON FUNCTION public.direct_pay_otp_mark(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.direct_pay_otp_mark(uuid, boolean, text) TO service_role;

-- ---------------------------------------------------------------- 7. money helpers used by approve
-- 2% Cover fee: partner operational float -> proxy agent (or Welile revenue when there is none).
-- Same earner rule and commission records as _offplatform_cover_charge; the float bucket is the only difference.
CREATE OR REPLACE FUNCTION public._direct_pay_cover_charge(p_payment_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  p public.funder_offplatform_rent_payments%ROWTYPE;
  v_idem text := 'opcover-' || p_payment_id::text;
  v_e uuid; v_path text; v_note uuid; v_asg uuid; v_basis text; v_group uuid; v_rate numeric;
  v_label text;
BEGIN
  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id;
  IF COALESCE(p.cover_fee_amount, 0) <= 0 THEN RETURN 'none'; END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_idem) THEN RETURN 'charged'; END IF;
  IF public.get_user_float_available_balance(p.funder_id) < p.cover_fee_amount THEN RETURN 'awaiting_topup'; END IF;

  SELECT r.earner_id, r.earner_path, r.note_id, r.assignment_id, r.basis
    INTO v_e, v_path, v_note, v_asg, v_basis
    FROM public.commission_resolve_earner(p.funder_id, now(), true) r LIMIT 1;
  v_label := 'Cover fee on a Rent Plan paid to the landlord directly (' || p.id::text || ')';
  v_rate := round(p.cover_fee_amount / NULLIF(p.amount, 0), 4);

  IF v_e IS NULL OR v_e = p.funder_id THEN
    v_group := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', p.funder_id, 'amount', p.cover_fee_amount, 'direction', 'cash_out',
        'category', 'welile_cover_fee', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id::text, 'reference_id', v_idem,
        'description', 'Cover fee from operational float: ' || v_label),
      jsonb_build_object('amount', p.cover_fee_amount, 'direction', 'cash_in', 'category', 'welile_cover_fee',
        'ledger_scope', 'platform', 'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id::text,
        'reference_id', v_idem, 'linked_party', p.funder_id::text, 'description', 'Cover fee kept (no proxy agent): ' || v_label)),
      v_idem);
    UPDATE public.funder_offplatform_rent_payments SET cover_fee_ledger_group_id = v_group, cover_fee_charged_at = now() WHERE id = p.id;
    RETURN 'kept';
  END IF;

  v_group := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('user_id', p.funder_id, 'amount', p.cover_fee_amount, 'direction', 'cash_out',
      'category', 'welile_cover_fee', 'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
      'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id::text, 'reference_id', v_idem,
      'linked_party', v_e::text, 'description', 'Cover fee from operational float: ' || v_label),
    jsonb_build_object('user_id', v_e, 'amount', p.cover_fee_amount, 'direction', 'cash_in',
      'category', CASE WHEN v_path = 'managed_proxy' THEN 'partner_commission' ELSE 'agent_commission' END,
      'ledger_scope', 'wallet', 'recipient_type', 'user',
      'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id::text, 'reference_id', v_idem,
      'linked_party', p.funder_id::text, 'description', v_label)),
    v_idem);
  UPDATE public.funder_offplatform_rent_payments
     SET cover_fee_ledger_group_id = v_group, cover_fee_charged_at = now(), proxy_agent_id = v_e WHERE id = p.id;

  IF v_path = 'managed_proxy' THEN
    INSERT INTO public.proxy_commission_queue
      (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount, source_table, source_id,
       idempotency_key, status, auto_approved, decided_at, decision_note, ledger_group_id)
    SELECT 'portfolio_creation', v_e, p.funder_id, v_asg, p.amount, COALESCE(NULLIF(v_rate, 0), 0.02), p.cover_fee_amount,
           'funder_offplatform_rent_payments', p.id::text, v_idem, 'paid', true, now(), 'direct_pay_cover', v_group
     WHERE NOT EXISTS (SELECT 1 FROM public.proxy_commission_queue q WHERE q.idempotency_key = v_idem);
  ELSE
    INSERT INTO public.promissory_commission_events
      (note_id, agent_id, partner_id, kind, base_amount, rate, amount, source_table, source_id,
       idempotency_key, ledger_group_id, status)
    SELECT v_note, v_e, p.funder_id, 'portfolio_creation', p.amount, COALESCE(NULLIF(v_rate, 0), 0.02), p.cover_fee_amount,
           'funder_offplatform_rent_payments', p.id::text, v_idem, v_group, 'paid'
     WHERE NOT EXISTS (SELECT 1 FROM public.promissory_commission_events e WHERE e.idempotency_key = v_idem);
  END IF;
  RETURN 'charged';
END $$;
REVOKE ALL ON FUNCTION public._direct_pay_cover_charge(uuid) FROM PUBLIC, anon, authenticated;

-- Agent 1% + UGX 5,000, as the landlord payout triggers pay them (post_landlord_payout_finops_commission and
-- pay_agent_posted_rent_bonus_on_landlord_paid): same categories, the bonus with the SAME key and skip rules.
CREATE OR REPLACE FUNCTION public._direct_pay_agent_pay(p_payment_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  p public.funder_offplatform_rent_payments%ROWTYPE;
  v_rr record;
  v_commission numeric;
  v_g1 uuid; v_g2 uuid;
  v_key text;
BEGIN
  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id;
  v_commission := ROUND(p.amount * 0.01);
  IF p.agent_id IS NOT NULL AND v_commission > 0
     AND NOT EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = 'direct-pay-commission-' || p.id::text) THEN
    v_g1 := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', p.agent_id, 'amount', v_commission, 'direction', 'cash_in',
        'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'recipient_type', 'user',
        'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id, 'currency', 'UGX',
        'reference_id', p.id::text || '-direct-pay-commission',
        'description', '1% commission: partner paid landlord directly, confirmed by Landlord Ops'),
      jsonb_build_object('amount', v_commission, 'direction', 'cash_out', 'category', 'marketing_expense',
        'ledger_scope', 'platform', 'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id, 'currency', 'UGX',
        'reference_id', p.id::text || '-direct-pay-commission',
        'description', 'Platform expense: 1% agent commission for a direct landlord payment ' || p.id::text)),
      'direct-pay-commission-' || p.id::text, true);
  END IF;

  SELECT rr.id, rr.agent_id, rr.tenant_id, rr.status, rr.tenant_ops_reviewed_at, rr.tenant_ops_reviewed_by
    INTO v_rr FROM public.rent_requests rr WHERE rr.id = p.rent_request_id;
  v_key := 'agent-posted-rent-bonus-' || v_rr.id::text;
  IF v_rr.agent_id IS NOT NULL AND v_rr.agent_id IS DISTINCT FROM v_rr.tenant_id
     AND v_rr.tenant_ops_reviewed_at IS NOT NULL AND v_rr.tenant_ops_reviewed_by IS NOT NULL
     AND v_rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
     AND NOT EXISTS (SELECT 1 FROM public.general_ledger g
                      WHERE g.idempotency_key IN (v_key, 'fund-agent-landlord-float:' || v_rr.id::text || ':bonus')) THEN
    v_g2 := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('user_id', v_rr.agent_id, 'amount', 5000, 'direction', 'cash_in', 'category', 'agent_commission_earned',
        'ledger_scope', 'wallet', 'recipient_type', 'user', 'source_table', 'rent_requests', 'source_id', v_rr.id,
        'reference_id', v_key, 'currency', 'UGX', 'transaction_date', now(),
        'description', 'Bonus: rent request approved by Tenant Operations and the landlord paid'),
      jsonb_build_object('amount', 5000, 'direction', 'cash_out', 'category', 'agent_commission_earned',
        'ledger_scope', 'platform', 'source_table', 'rent_requests', 'source_id', v_rr.id,
        'reference_id', v_key, 'currency', 'UGX', 'transaction_date', now(),
        'description', 'Platform expense: agent bonus for a rent request, landlord paid directly by the partner')),
      v_key);
  END IF;
  RETURN jsonb_build_object('commission', CASE WHEN v_g1 IS NOT NULL THEN v_commission ELSE 0 END,
                            'bonus', CASE WHEN v_g2 IS NOT NULL THEN 5000 ELSE 0 END, 'commission_group', v_g1, 'bonus_group', v_g2);
END $$;
REVOKE ALL ON FUNCTION public._direct_pay_agent_pay(uuid) FROM PUBLIC, anon, authenticated;

-- WLR receipt, same table, numbering and snapshot shape as issue_landlord_payout_receipt; payout_id = the payment.
CREATE OR REPLACE FUNCTION public._direct_pay_issue_receipt(p_payment_id uuid, p_staff uuid) RETURNS public.landlord_payout_receipts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  p public.funder_offplatform_rent_payments%ROWTYPE;
  r public.landlord_payout_receipts;
  v_rr public.rent_requests%ROWTYPE;
  v_house public.house_listings;
  v_number text;
  v_tids text;
  v_provider text;
BEGIN
  SELECT * INTO r FROM public.landlord_payout_receipts WHERE payout_id = p_payment_id;
  IF FOUND THEN RETURN r; END IF;
  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id;
  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p.rent_request_id;
  SELECT * INTO v_house FROM public.house_listings WHERE tenant_id = v_rr.tenant_id ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  SELECT string_agg(COALESCE(NULLIF(btrim(f.tid_typed), ''), f.tid_read), ', ' ORDER BY f.created_at), max(f.provider)
    INTO v_tids, v_provider FROM public.funder_offplatform_rent_proofs f WHERE f.payment_id = p.id;

  v_number := 'WLR-' || nextval('public.landlord_receipt_number_seq')::text;
  INSERT INTO public.landlord_payout_receipts (
    payout_id, receipt_number, amount, landlord_id, tenant_id, agent_id, processed_by, landlord_phone, snapshot, generated_by)
  VALUES (p.id, v_number, p.amount, p.landlord_id, v_rr.tenant_id, p.agent_id, p_staff, p.landlord_phone,
    jsonb_build_object(
      'receipt_number', v_number, 'status', 'completed', 'amount', p.amount,
      'landlord_name', COALESCE((SELECT name FROM public.landlords WHERE id = p.landlord_id), 'Landlord'),
      'tenant_name', COALESCE((SELECT full_name FROM public.profiles WHERE id = v_rr.tenant_id), 'Tenant'),
      'agent_name', (SELECT full_name FROM public.profiles WHERE id = p.agent_id),
      'rent_period', to_char(now(), 'FMMonth YYYY'),
      'house_type', COALESCE(v_house.house_category, 'Rental Unit'),
      'property_address', NULLIF(concat_ws(', ', NULLIF(v_house.address, ''), NULLIF(v_house.village, ''),
                                           NULLIF(v_house.sub_county, ''), NULLIF(v_house.district, '')), ''),
      'paid_at', now(),
      'processed_by_name', COALESCE((SELECT full_name FROM public.profiles WHERE id = p_staff), 'Welile Staff'),
      'processor_role', 'Landlord Operations',
      'payment_method', 'Mobile Money' || CASE WHEN v_provider IS NOT NULL THEN ' (' || upper(v_provider) || ')' ELSE '' END
                        || ', paid by the partner',
      'transaction_reference', COALESCE(v_tids, '—')),
    p_staff)
  RETURNING * INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public._direct_pay_issue_receipt(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 8. approve
CREATE OR REPLACE FUNCTION public.direct_pay_approve(p_payment_id uuid, p_otp text, p_call_note text, p_flag_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE
  v_uid uuid := auth.uid();
  p public.funder_offplatform_rent_payments%ROWTYPE;
  o public.direct_pay_landlord_otps%ROWTYPE;
  v_rr public.rent_requests%ROWTYPE;
  v_now timestamptz := now();
  v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_term int := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
  v_commitment uuid;
  v_line uuid;
  v_portfolio uuid;
  v_agent uuid;
  v_capital uuid;
  v_fee_status text;
  v_pay jsonb;
  v_receipt public.landlord_payout_receipts;
  v_status text;
BEGIN
  IF NOT public._direct_pay_can_act(v_uid) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;

  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id AND flow = 'direct_pay' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF p.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_pending', 'status', p.status); END IF;
  PERFORM public._direct_pay_plan_lock(p.rent_request_id);

  IF NULLIF(btrim(p_call_note), '') IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'call_note_required'); END IF;
  IF cardinality(p.flags) > 0 AND NULLIF(btrim(p_flag_reason), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'flag_reason_required', 'flags', p.flags);
  END IF;

  -- The landlord's code. A wrong code is counted and saved (the function returns normally, so nothing rolls back).
  SELECT * INTO o FROM public.direct_pay_landlord_otps
   WHERE payment_id = p.id AND status IN ('sent', 'issued', 'locked') ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'otp_required'); END IF;
  IF o.status = 'locked' OR o.attempts >= o.max_attempts THEN RETURN jsonb_build_object('ok', false, 'code', 'otp_locked'); END IF;
  IF o.expires_at <= v_now THEN RETURN jsonb_build_object('ok', false, 'code', 'otp_expired'); END IF;
  IF encode(digest(btrim(COALESCE(p_otp, '')), 'sha256'), 'hex') <> o.otp_hash THEN
    UPDATE public.direct_pay_landlord_otps
       SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= max_attempts THEN 'locked' ELSE status END
     WHERE id = o.id;
    RETURN jsonb_build_object('ok', false, 'code', 'otp_wrong', 'attempts_left', GREATEST(0, o.max_attempts - o.attempts - 1));
  END IF;

  IF NOT public.funder_has_signed_agreement(p.funder_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'agreement_required');
  END IF;
  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p.rent_request_id FOR UPDATE;
  IF v_rr.funded_at IS NOT NULL OR v_rr.disbursed_at IS NOT NULL OR v_rr.self_funding_partner_id IS NOT NULL
     OR v_rr.status NOT IN ('approved', 'coo_approved', 'pending', 'agent_ops_approved', 'tenant_ops_approved',
                            'landlord_ops_approved', 'agent_verified', 'cfo_approved') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'plan_changed', 'plan_status', v_rr.status);
  END IF;
  IF public._direct_pay_tenant_owes(p.rent_request_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'tenant_still_owes');
  END IF;

  -- A TID is approved once, ever (ux_fop_proofs_tid_approved).
  BEGIN
    UPDATE public.funder_offplatform_rent_proofs SET status = 'approved' WHERE payment_id = p.id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'tid_already_approved');
  END;
  UPDATE public.direct_pay_landlord_otps SET status = 'verified', verified_at = v_now WHERE id = o.id;

  -- Confirmed first: the repaying gate below reads it.
  UPDATE public.funder_offplatform_rent_payments
     SET status = 'confirmed', confirmed_at = v_now, confirmed_by = v_uid,
         landlord_otp_verified_at = v_now, call_note = btrim(p_call_note),
         flag_reason = NULLIF(btrim(p_flag_reason), '')
   WHERE id = p.id;

  -- Same records as option 1, active at once (no Partner Ops step, no wallet debit).
  PERFORM set_config('app.direct_pay_approving', p.id::text, true);
  v_rate := public.partner_rate_now(p.funder_id);
  INSERT INTO public.partner_self_commitments (partner_id, committed_amount, term_months, monthly_rate, lines_count,
                                               idempotency_key, status)
  VALUES (p.funder_id, p.amount, v_term, v_rate, 1, 'direct-pay-' || p.id::text, 'pending_ops_approval')
  RETURNING id INTO v_commitment;
  INSERT INTO public.partner_self_funding_lines (commitment_id, partner_id, rent_request_id, principal, rent_amount,
                                                 proxy_fee, proxy_fee_status, monthly_rate, term_months)
  VALUES (v_commitment, p.funder_id, p.rent_request_id, p.amount, p.amount, 0, NULL, v_rate, v_term)
  RETURNING id INTO v_line;

  UPDATE public.rent_requests
     SET status = 'funded', funded_at = v_now, self_funding_partner_id = p.funder_id, self_funding_line_id = v_line,
         updated_at = v_now
   WHERE id = p.rent_request_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios WHERE investor_id = p.funder_id ORDER BY created_at LIMIT 1;
  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months,
                                          roi_mode, status, portfolio_pin, activation_token, total_roi_earned)
  VALUES (p.funder_id, COALESCE(v_agent, p.funder_id), 'WSP-' || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0'),
          p.amount, v_term, 'monthly_payout', 'pending_ops_approval',
          lpad((floor(random() * 9000) + 1000)::int::text, 4, '0'), gen_random_uuid(), 0)
  RETURNING id, roi_percentage INTO v_portfolio, v_stored;
  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment, v_stored);
  END IF;
  INSERT INTO public.funder_pending_portfolios (portfolio_id, funder_id, amount, source, commitment_id, term_months,
                                                status, reviewed_by, reviewed_at)
  VALUES (v_portfolio, p.funder_id, p.amount, 'self_managed', v_commitment, v_term, 'approved', v_uid, v_now);

  -- Rent Profit Share from today, as _ssd_activate does once a landlord is paid.
  UPDATE public.investor_portfolios
     SET status = 'active', next_roi_date = v_day + 30,
         maturity_date = (v_day + (v_term || ' months')::interval)::date
   WHERE id = v_portfolio;
  PERFORM set_config('welile.portfolio_trusted', '', true);
  PERFORM set_config('app.ss_system_release', 'on', true);
  UPDATE public.partner_self_commitments
     SET status = 'active', payout_anchor_at = v_now, payout_day = EXTRACT(DAY FROM v_now)::smallint,
         next_payout_at = v_now + interval '1 month', term_end_at = v_now + (v_term || ' months')::interval, updated_at = v_now
   WHERE id = v_commitment;
  PERFORM set_config('app.ss_system_release', '', true);
  UPDATE public.partner_self_funding_lines
     SET status = 'active', live_at = v_now, term_end_at = v_now + (v_term || ' months')::interval, updated_at = v_now
   WHERE id = v_line;

  -- The portfolio's activation would queue a 2% fund-in commission; the Cover fee already pays the proxy agent.
  UPDATE public.commission_fund_in_candidates
     SET state = 'not_commissionable', note = 'Option 2: the Cover fee from the partner float pays the proxy agent'
   WHERE source_table = 'investor_portfolios' AND source_key = v_portfolio::text AND event = 'portfolio_activation'
     AND state = 'pending';

  -- Books: tenant owes the rent (A3), Welile owes the partner (L2). No cash.
  v_capital := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('amount', p.amount, 'direction', 'cash_in', 'category', 'rent_receivable_created', 'ledger_scope', 'bridge',
      'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id::text, 'reference_id', p.rent_request_id::text,
      'description', 'Rent Plan receivable: the partner paid the landlord directly'),
    jsonb_build_object('amount', p.amount, 'direction', 'cash_out', 'category', 'partner_direct_rent_capital',
      'ledger_scope', 'platform', 'source_table', 'funder_offplatform_rent_payments', 'source_id', p.id::text,
      'reference_id', p.rent_request_id::text, 'linked_party', p.funder_id::text,
      'description', 'Partner capital: Rent Plan paid to the landlord directly, confirmed by Landlord Ops')),
    'direct-pay-' || p.id::text);
  PERFORM public.recognise_funding_treasury(p.rent_request_id);

  v_fee_status := public._direct_pay_cover_charge(p.id);
  v_pay := public._direct_pay_agent_pay(p.id);
  v_receipt := public._direct_pay_issue_receipt(p.id, v_uid);

  -- The landlord is paid: repayments start tomorrow (the gate accepts a confirmed direct payment).
  UPDATE public.rent_requests SET status = 'repaying', repayment_starts_on = v_day + 1, updated_at = now()
   WHERE id = p.rent_request_id AND status = 'funded';
  SELECT status INTO v_status FROM public.rent_requests WHERE id = p.rent_request_id;
  IF v_status <> 'repaying' THEN
    RAISE EXCEPTION 'direct pay: the Rent Plan did not move to repaying (status %)', v_status;
  END IF;

  UPDATE public.funder_offplatform_rent_payments
     SET portfolio_id = v_portfolio, ledger_group_id = v_capital,
         agent_pay_ledger_group_id = (v_pay->>'commission_group')::uuid, receipt_id = v_receipt.id,
         cover_fee_status = CASE v_fee_status WHEN 'none' THEN cover_fee_status ELSE v_fee_status END
   WHERE id = p.id;
  PERFORM set_config('app.direct_pay_approving', '', true);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'direct_pay_approved', 'funder_offplatform_rent_payments', p.id::text, 'direct_pay_approved',
          'Landlord Ops confirmed the landlord was paid (call + landlord OTP)',
          jsonb_build_object('portfolio_id', v_portfolio, 'commitment_id', v_commitment, 'amount', p.amount,
                             'flags', p.flags, 'flag_reason', p_flag_reason, 'cover_fee', v_fee_status, 'agent_pay', v_pay,
                             'receipt_number', v_receipt.receipt_number, 'ledger_group_id', v_capital));
  PERFORM public.psm_audit(v_uid, p.funder_id, 'direct_pay_portfolio_active', 'partner_self_commitments', v_commitment,
                           jsonb_build_object('payment_id', p.id, 'portfolio_id', v_portfolio, 'amount', p.amount));

  RETURN jsonb_build_object('ok', true, 'payment_id', p.id, 'portfolio_id', v_portfolio, 'commitment_id', v_commitment,
                            'receipt_number', v_receipt.receipt_number, 'receipt_code', v_receipt.receipt_code,
                            'cover_fee_status', v_fee_status, 'agent_pay', v_pay, 'repayment_starts_on', v_day + 1);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_approve(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_approve(uuid, text, text, text) TO authenticated;

-- ---------------------------------------------------------------- 9. reject
CREATE OR REPLACE FUNCTION public.direct_pay_reject(p_payment_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  p public.funder_offplatform_rent_payments%ROWTYPE;
BEGIN
  IF NOT public._direct_pay_can_act(v_uid) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'reason_required'); END IF;
  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id AND flow = 'direct_pay' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF p.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_pending', 'status', p.status); END IF;

  UPDATE public.funder_offplatform_rent_payments
     SET status = 'rejected', rejected_at = now(), rejected_by = v_uid, reject_note = btrim(p_reason),
         cover_fee_status = CASE WHEN cover_fee_status = 'awaiting_confirmation' THEN 'waived' ELSE cover_fee_status END
   WHERE id = p.id;
  UPDATE public.funder_offplatform_rent_proofs SET status = 'rejected' WHERE payment_id = p.id;
  UPDATE public.direct_pay_landlord_otps SET status = 'replaced' WHERE payment_id = p.id AND status IN ('issued', 'sent', 'send_failed');

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'direct_pay_rejected', 'funder_offplatform_rent_payments', p.id::text, 'direct_pay_rejected',
          btrim(p_reason), jsonb_build_object('amount', p.amount, 'flags', p.flags, 'rent_request_id', p.rent_request_id));
  RETURN jsonb_build_object('ok', true, 'payment_id', p.id, 'status', 'rejected');
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_reject(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_reject(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- 10. post-checks
DO $check$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.gate_repaying_on_merchant_landlord_payout()'::regprocedure)
     NOT LIKE '%_direct_pay_landlord_paid%' THEN
    RAISE EXCEPTION 'direct pay phase 3: the repaying gate was not updated';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = '_am_plan_clock_core' AND pronamespace = 'public'::regnamespace)
     NOT LIKE '%funder_offplatform_rent_payments%' THEN
    RAISE EXCEPTION 'direct pay phase 3: the plan clock was not updated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_function_privilege('authenticated', 'public.direct_pay_otp_issue(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'direct pay phase 3: the browser must never be able to issue (and read) a landlord code';
  END IF;
END
$check$;
