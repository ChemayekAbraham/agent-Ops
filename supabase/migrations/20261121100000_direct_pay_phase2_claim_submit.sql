-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Self-support option 2 (the partner pays the landlord directly). Phase 2: claim and submit, partner side.
-- Needs 20261121090000 (phase 1). Everything is behind the switch self_support_direct_pay (OFF): with it off,
-- direct_pay_claim answers 'not_available' and nothing else can start.
--
--   * direct_pay_claim(plan)          one atomic call: holds the plan 48 h, holds the 2% Cover fee on the partner's
--                                     operational float, returns the landlord's name and VERIFIED number.
--   * direct_pay_release(payment)     the partner lets go before uploading anything.
--   * direct_pay_record_proof(...)    service_role only, called by the edge function direct-pay-proof after it has
--                                     read the SMS itself (the browser can never hand in "read" values).
--   * direct_pay_refresh(payment)     re-checks a held payment (e.g. after a float top-up) and returns its status.
--   * direct_pay_my_payments()        the partner's direct payments with their proofs, one query.
--
-- A held plan leaves the pool everywhere at once: v_partner_self_fundable_plans (read by 17 functions: partner
-- list, wallet claim, promissory notes, co-support, boards, share links) gains one NOT EXISTS, and
-- psm_plan_partner_reserved_stage gains the stage 'direct_pay_held' (CFO / COO queues and the company-float
-- fence already read it). Both are edited by appending to the LIVE definition, after an md5 check that it is
-- the definition this file was written against.
--
-- Same-second races: every path that can fund a Rent Plan takes the advisory lock rent-plan-claim:<plan> before
-- deciding. Direct pay vs direct pay is also settled by ux_fopr_direct_pay_live_plan (phase 1).
-- Replaces no protected (locked) function; the guard below refuses if that ever changes.
-- REQUIRES THE OWNER'S YES before it is applied to production.

SET lock_timeout = '5s';

-- ---------------------------------------------------------------- 0. guards
DO $guard$
DECLARE
  v_names text[] := ARRAY['psm_plan_partner_reserved_stage', 'psm_reserved_plan_ids', 'funder_pending_hold',
                          '_direct_pay_on', '_direct_pay_plan_lock', '_direct_pay_tenant_owes', '_direct_pay_flags', '_direct_pay_evaluate',
                          '_direct_pay_partner_view', 'direct_pay_claim', 'direct_pay_release', 'direct_pay_record_proof',
                          'direct_pay_refresh', 'direct_pay_my_payments', 'trg_direct_pay_plan_guard'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'funder_offplatform_rent_payments' AND column_name = 'flow') THEN
    RAISE EXCEPTION 'direct pay phase 2: phase 1 (20261121090000) is not applied';
  END IF;
  IF to_regclass('public.protected_functions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.protected_functions WHERE func_name = ANY (v_names)) THEN
    RAISE EXCEPTION 'direct pay phase 2: a function this file replaces is protected (locked)';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------- 0b. keep the four originals this file edits
-- The rollback restores them from here byte for byte. Saved once (first apply only).
CREATE TABLE IF NOT EXISTS public.direct_pay_saved_definitions (
  object_name text PRIMARY KEY,
  definition  text NOT NULL,
  saved_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.direct_pay_saved_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.direct_pay_saved_definitions;
CREATE POLICY mfa_required_for_staff ON public.direct_pay_saved_definitions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON public.direct_pay_saved_definitions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.direct_pay_saved_definitions TO service_role;

INSERT INTO public.direct_pay_saved_definitions (object_name, definition)
VALUES ('view:v_partner_self_fundable_plans', pg_get_viewdef('public.v_partner_self_fundable_plans'::regclass, true)),
       ('function:psm_plan_partner_reserved_stage', pg_get_functiondef('public.psm_plan_partner_reserved_stage(uuid)'::regprocedure)),
       ('function:psm_reserved_plan_ids', pg_get_functiondef('public.psm_reserved_plan_ids(uuid[])'::regprocedure)),
       ('function:funder_pending_hold', pg_get_functiondef('public.funder_pending_hold(uuid)'::regprocedure))
ON CONFLICT (object_name) DO NOTHING;

-- ---------------------------------------------------------------- 1. proofs: amount typed by the partner
-- Used only when the reader could not read an amount (the proof is then flagged photo_unreadable).
ALTER TABLE public.funder_offplatform_rent_proofs ADD COLUMN IF NOT EXISTS amount_typed numeric;
ALTER TABLE public.funder_offplatform_rent_proofs DROP CONSTRAINT IF EXISTS fop_proofs_amount_typed;
ALTER TABLE public.funder_offplatform_rent_proofs
  ADD CONSTRAINT fop_proofs_amount_typed CHECK (amount_typed IS NULL OR amount_typed > 0);

-- ---------------------------------------------------------------- 2. small helpers
CREATE OR REPLACE FUNCTION public._direct_pay_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT public._pipeline_switch_on('self_support_direct_pay') $$;

-- One lock name for every path that can fund a Rent Plan (direct pay, wallet claim, co-support, promissory).
CREATE OR REPLACE FUNCTION public._direct_pay_plan_lock(p_rent_request_id uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path TO 'public' AS
$$ SELECT pg_advisory_xact_lock(hashtext('rent-plan-claim:' || p_rent_request_id::text)) $$;

-- The rule enforce_no_funding_while_balance_outstanding applies when a plan is funded, asked up front: in option 2
-- the partner pays the landlord BEFORE funding, so a plan that could never be funded must not be offered.
CREATE OR REPLACE FUNCTION public._direct_pay_tenant_owes(p_rent_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rent_requests me
      JOIN public.rent_requests o ON o.tenant_id = me.tenant_id AND o.id <> me.id
     WHERE me.id = p_rent_request_id
       AND COALESCE(me.registration_type, '') <> 'outstanding_balance'
       AND o.status IN ('funded', 'repaying')
       AND COALESCE(o.tenancy_status, 'active') <> 'ended'
       AND COALESCE(o.schedule_status, '') <> 'cancelled'
       AND GREATEST(COALESCE(o.total_repayment, 0) - COALESCE(o.amount_repaid, 0), 0) > 0)
$$;

REVOKE ALL ON FUNCTION public._direct_pay_on() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._direct_pay_plan_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._direct_pay_tenant_owes(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 3. the pool: a held plan disappears
DO $view$
DECLARE
  v_def text := pg_get_viewdef('public.v_partner_self_fundable_plans'::regclass, true);
  v_add constant text := ' AND NOT (EXISTS ( SELECT 1 FROM funder_offplatform_rent_payments dp WHERE dp.rent_request_id = rr.id AND dp.flow = ''direct_pay''::text AND (dp.status = ANY (ARRAY[''pending''::text, ''confirmed''::text]) OR dp.status = ''held''::text AND dp.hold_expires_at > now())))';
BEGIN
  IF v_def LIKE '%funder_offplatform_rent_payments%' THEN
    RETURN;   -- already applied
  END IF;
  IF md5(v_def) <> '8139125c0560080c9d6cfbe1b2796d1c' THEN
    RAISE EXCEPTION 'direct pay phase 2: v_partner_self_fundable_plans changed since 2026-11-13 (md5 %); re-check the append', md5(v_def);
  END IF;
  v_def := regexp_replace(v_def, ';\s*$', '');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_partner_self_fundable_plans AS ' || v_def || v_add;
END
$view$;

DO $stage$
DECLARE
  v_src text;
  v_def text;
  v_when constant text := $w$
    WHEN EXISTS (
      SELECT 1 FROM public.funder_offplatform_rent_payments dp
       WHERE dp.rent_request_id = p_rent_request_id AND dp.flow = 'direct_pay'
         AND (dp.status IN ('pending', 'confirmed') OR (dp.status = 'held' AND dp.hold_expires_at > now()))
    ) THEN 'direct_pay_held'
    ELSE NULL END;$w$;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.psm_plan_partner_reserved_stage(uuid)'::regprocedure;
  IF v_src LIKE '%direct_pay_held%' THEN
    RETURN;
  END IF;
  IF md5(v_src) <> '94980b29337511c4b63a481829811bfc' THEN
    RAISE EXCEPTION 'direct pay phase 2: psm_plan_partner_reserved_stage changed since 2026-11-13 (md5 %)', md5(v_src);
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_src, 'ELSE\s+NULL\s+END', 'g')) <> 1
     OR v_src !~ 'ELSE\s+NULL\s+END;?\s*$' THEN
    RAISE EXCEPTION 'direct pay phase 2: psm_plan_partner_reserved_stage does not end in exactly one ELSE NULL END';
  END IF;
  v_def := regexp_replace(v_src, 'ELSE\s+NULL\s+END;?\s*$', '') || v_when;
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.psm_plan_partner_reserved_stage(p_rent_request_id uuid)
    RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $body$%s$body$$f$, v_def);
END
$stage$;

-- The stage function was called twice per plan; once is enough.
CREATE OR REPLACE FUNCTION public.psm_reserved_plan_ids(p_rent_request_ids uuid[])
 RETURNS TABLE(rent_request_id uuid, reserved_stage text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x, s.stage
    FROM unnest(COALESCE(p_rent_request_ids, ARRAY[]::uuid[])) AS x
    CROSS JOIN LATERAL (SELECT public.psm_plan_partner_reserved_stage(x) AS stage) s
   WHERE s.stage IS NOT NULL;
$function$;

-- ---------------------------------------------------------------- 4. the Cover fee is held on the float
DO $hold$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.funder_pending_hold(uuid)'::regprocedure;
  IF v_src LIKE '%funder_offplatform_rent_payments%' THEN
    RETURN;
  END IF;
  IF md5(v_src) <> 'e18b19ad3c8358dcd7281bbd4977b0d4' THEN
    RAISE EXCEPTION 'direct pay phase 2: funder_pending_hold changed since 2026-11-13 (md5 %)', md5(v_src);
  END IF;
END
$hold$;

CREATE OR REPLACE FUNCTION public.funder_pending_hold(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
  SELECT COALESCE(SUM(f.amount), 0)::numeric
  FROM public.funder_pending_portfolios f
  WHERE f.funder_id = p_user_id
    AND f.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || f.portfolio_id::text
           OR (g.source_table = 'investor_portfolios' AND g.source_id = f.portfolio_id)
           OR (f.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = f.commitment_id))
         )
    ))
  -- Co-support: the lead's half stays held while their invitation is open.
  + COALESCE((
      SELECT SUM(i.lead_share)
        FROM public.co_support_invites i
       WHERE i.lead_partner_id = p_user_id
         AND i.status = 'open'
         AND i.expires_at > now()), 0)
  -- Option 2 (20261121100000): the 2% Cover fee stays held from the claim until it is charged or the hold ends.
  + COALESCE((
      SELECT SUM(dp.cover_fee_amount)
        FROM public.funder_offplatform_rent_payments dp
       WHERE dp.funder_id = p_user_id
         AND dp.flow = 'direct_pay'
         AND dp.cover_fee_status = 'awaiting_confirmation'
         AND (dp.status = 'pending' OR (dp.status = 'held' AND dp.hold_expires_at > now()))), 0);
END;
$function$;

-- ---------------------------------------------------------------- 5. option 1 paths refuse a held plan
-- Before any insert that would fund or reserve a Rent Plan: take the same plan lock as direct_pay_claim, then look
-- for a live direct payment. Wallet claims are skipped quietly (partner_self_claim_plans then reports the plan as
-- taken by another partner, which is what happened); everything else is refused with a reason.
CREATE OR REPLACE FUNCTION public.trg_direct_pay_plan_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;
  -- The approval itself (phase 3) inserts this plan's funding line while its own payment is live.
  IF TG_TABLE_NAME = 'partner_self_funding_lines'
     AND NULLIF(current_setting('app.direct_pay_approving', true), '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments dp
                  WHERE dp.id::text = current_setting('app.direct_pay_approving', true)
                    AND dp.rent_request_id = NEW.rent_request_id AND dp.flow = 'direct_pay') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'co_support_invites' AND NEW.status IS DISTINCT FROM 'open' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'promissory_note_plan_intents' AND NEW.status IS DISTINCT FROM 'reserved' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'partner_self_plan_claims' AND NEW.status NOT IN ('held', 'confirmed') THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'partner_self_plan_claims' THEN
    -- partner_self_claim_plans claims many plans in one statement; waiting on per-plan locks there could deadlock
    -- two partners whose lists overlap. Never wait: a plan someone is claiming right now is simply skipped.
    IF NOT pg_try_advisory_xact_lock(hashtext('rent-plan-claim:' || NEW.rent_request_id::text)) THEN
      RETURN NULL;
    END IF;
  ELSE
    PERFORM public._direct_pay_plan_lock(NEW.rent_request_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.funder_offplatform_rent_payments dp
              WHERE dp.rent_request_id = NEW.rent_request_id AND dp.flow = 'direct_pay'
                AND (dp.status IN ('pending', 'confirmed') OR (dp.status = 'held' AND dp.hold_expires_at > now()))) THEN
    IF TG_TABLE_NAME = 'partner_self_plan_claims' THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'DIRECT_PAY_HELD: a partner is paying this landlord directly, so this Rent Plan cannot be funded another way.'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.trg_direct_pay_plan_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.partner_self_plan_claims;
CREATE TRIGGER aa_direct_pay_plan_guard BEFORE INSERT ON public.partner_self_plan_claims
  FOR EACH ROW EXECUTE FUNCTION public.trg_direct_pay_plan_guard();
DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.partner_self_funding_lines;
CREATE TRIGGER aa_direct_pay_plan_guard BEFORE INSERT ON public.partner_self_funding_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_direct_pay_plan_guard();
DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.co_support_invites;
CREATE TRIGGER aa_direct_pay_plan_guard BEFORE INSERT ON public.co_support_invites
  FOR EACH ROW EXECUTE FUNCTION public.trg_direct_pay_plan_guard();
DROP TRIGGER IF EXISTS aa_direct_pay_plan_guard ON public.promissory_note_plan_intents;
CREATE TRIGGER aa_direct_pay_plan_guard BEFORE INSERT ON public.promissory_note_plan_intents
  FOR EACH ROW EXECUTE FUNCTION public.trg_direct_pay_plan_guard();

-- ---------------------------------------------------------------- 6. flags (Landlord Ops only, never shown to the partner)
-- One statement over this payment's proofs. Each flag is evidence for the call, not a decision.
CREATE OR REPLACE FUNCTION public._direct_pay_flags(p_payment_id uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH pay AS (
    SELECT p.id, p.amount, p.amount_received, p.hold_started_at,
           public.landlord_number_norm(p.landlord_phone) AS landlord_norm
      FROM public.funder_offplatform_rent_payments p WHERE p.id = p_payment_id
  ), pr AS (
    SELECT f.* FROM public.funder_offplatform_rent_proofs f WHERE f.payment_id = p_payment_id
  )
  SELECT COALESCE(array_agg(flag ORDER BY flag), '{}'::text[]) FROM (
    SELECT 'tid_used_before' AS flag WHERE EXISTS (
      SELECT 1 FROM pr WHERE pr.tid_norm IS NOT NULL AND (
           EXISTS (SELECT 1 FROM public.deposit_requests d WHERE public.normalize_momo_tid(d.transaction_id) = pr.tid_norm)
        OR EXISTS (SELECT 1 FROM public.withdrawal_requests w WHERE public.normalize_momo_tid(w.transaction_id) = pr.tid_norm)
        OR EXISTS (SELECT 1 FROM public.withdrawal_requests w WHERE public.normalize_momo_tid(w.fin_ops_reference) = pr.tid_norm)
        OR EXISTS (SELECT 1 FROM public.landlord_payouts l WHERE public.normalize_momo_tid(l.finops_momo_reference) = pr.tid_norm)
        OR EXISTS (SELECT 1 FROM public.landlord_payouts l WHERE public.normalize_momo_tid(l.external_reference) = pr.tid_norm)
        OR EXISTS (SELECT 1 FROM public.funder_offplatform_rent_proofs o
                    WHERE o.tid_norm = pr.tid_norm AND o.payment_id <> p_payment_id)))
    UNION ALL
    -- 5 minutes of slack for phone clocks; a payment from before the hold is someone else's old payment.
    SELECT 'paid_before_hold' WHERE EXISTS (
      SELECT 1 FROM pr, pay WHERE pr.paid_at_read IS NOT NULL AND pr.paid_at_read < pay.hold_started_at - interval '5 minutes')
    UNION ALL
    SELECT 'wrong_number' WHERE EXISTS (
      SELECT 1 FROM pr, pay WHERE pr.recipient_read IS NOT NULL
         AND public.landlord_number_norm(pr.recipient_read) IS DISTINCT FROM pay.landlord_norm)
    UNION ALL
    SELECT 'number_not_read' WHERE EXISTS (SELECT 1 FROM pr WHERE pr.recipient_read IS NULL)
    UNION ALL
    SELECT 'tids_differ' WHERE EXISTS (
      SELECT 1 FROM pr WHERE NULLIF(btrim(pr.tid_typed), '') IS NOT NULL AND pr.tid_read IS NOT NULL
         AND public.normalize_momo_tid(pr.tid_typed) IS DISTINCT FROM public.normalize_momo_tid(pr.tid_read))
    UNION ALL
    SELECT 'photo_unreadable' WHERE EXISTS (SELECT 1 FROM pr WHERE pr.reader_status <> 'read' OR pr.amount_read IS NULL)
    UNION ALL
    SELECT 'same_photo' WHERE EXISTS (
      SELECT 1 FROM pr JOIN public.funder_offplatform_rent_proofs o
        ON o.photo_sha256 = pr.photo_sha256 AND o.payment_id <> p_payment_id
     WHERE pr.photo_sha256 IS NOT NULL)
    UNION ALL
    SELECT 'paid_more' WHERE EXISTS (SELECT 1 FROM pay WHERE pay.amount_received > pay.amount)
  ) f;
$$;
REVOKE ALL ON FUNCTION public._direct_pay_flags(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 7. what the partner sees (no flags, no other people's data)
CREATE OR REPLACE FUNCTION public._direct_pay_partner_view(p_payment_id uuid, p_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'ok', p_code IS NULL,
    'code', p_code,
    'payment_id', p.id,
    'rent_request_id', p.rent_request_id,
    'status', p.status,
    'tenant_first_name', split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'Tenant'), ' ', 1),
    'landlord_name', COALESCE(NULLIF(btrim(ld.name), ''), 'Landlord'),
    'landlord_number', CASE WHEN p.status IN ('held', 'pending') THEN p.landlord_phone END,
    'amount_due', p.amount,
    'amount_received', p.amount_received,
    'amount_short', GREATEST(0, p.amount - p.amount_received),
    'cover_fee', p.cover_fee_amount,
    'float_available', public.funder_float_available(p.funder_id),
    'hold_expires_at', p.hold_expires_at,
    'proofs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', f.id,
               'amount', COALESCE(f.amount_read, f.amount_typed),
               'tid_last4', right(f.tid_norm, 4),
               'created_at', f.created_at) ORDER BY f.created_at)
        FROM public.funder_offplatform_rent_proofs f WHERE f.payment_id = p.id), '[]'::jsonb))
  FROM public.funder_offplatform_rent_payments p
  LEFT JOIN public.rent_requests rr ON rr.id = p.rent_request_id
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.landlords ld ON ld.id = p.landlord_id
  WHERE p.id = p_payment_id;
$$;
REVOKE ALL ON FUNCTION public._direct_pay_partner_view(uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 8. evaluate: totals, flags, held -> pending
-- Idempotent. Called after every proof and by direct_pay_refresh. The caller holds the row lock.
CREATE OR REPLACE FUNCTION public._direct_pay_evaluate(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  p public.funder_offplatform_rent_payments%ROWTYPE;
  v_received numeric;
  v_float_short numeric;
BEGIN
  SELECT * INTO p FROM public.funder_offplatform_rent_payments WHERE id = p_payment_id AND flow = 'direct_pay';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;

  IF p.status = 'held' AND p.hold_expires_at <= now() THEN
    UPDATE public.funder_offplatform_rent_payments
       SET status = 'expired', expired_at = now(),
           cover_fee_status = CASE WHEN cover_fee_status = 'awaiting_confirmation' THEN 'waived' ELSE cover_fee_status END
     WHERE id = p.id;
    RETURN public._direct_pay_partner_view(p.id, 'hold_ended');
  END IF;
  IF p.status <> 'held' THEN
    RETURN public._direct_pay_partner_view(p.id);
  END IF;

  SELECT COALESCE(SUM(COALESCE(f.amount_read, f.amount_typed)), 0) INTO v_received
    FROM public.funder_offplatform_rent_proofs f WHERE f.payment_id = p.id AND f.status <> 'rejected';
  UPDATE public.funder_offplatform_rent_payments SET amount_received = v_received WHERE id = p.id;
  UPDATE public.funder_offplatform_rent_payments SET flags = public._direct_pay_flags(p.id) WHERE id = p.id;

  IF v_received < p.amount THEN
    RETURN public._direct_pay_partner_view(p.id, CASE WHEN v_received > 0 THEN 'amount_short' END);
  END IF;

  -- The fee is already inside funder_pending_hold; the float must still cover every hold the partner has.
  v_float_short := GREATEST(0, public.funder_pending_hold(p.funder_id) - public.get_user_float_available_balance(p.funder_id));
  IF p.cover_fee_amount > 0 AND v_float_short > 0 THEN
    RETURN public._direct_pay_partner_view(p.id, 'float_short') || jsonb_build_object('float_short', v_float_short);
  END IF;

  UPDATE public.funder_offplatform_rent_payments SET status = 'pending' WHERE id = p.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (p.funder_id, 'direct_pay_proof_complete', 'funder_offplatform_rent_payments', p.id::text,
          'direct_pay_proof_complete', 'Proofs reach the Rent Plan amount; waiting for Landlord Ops',
          jsonb_build_object('amount_due', p.amount, 'amount_received', v_received,
                             'flags', (SELECT flags FROM public.funder_offplatform_rent_payments WHERE id = p.id)));
  RETURN public._direct_pay_partner_view(p.id);
END $$;
REVOKE ALL ON FUNCTION public._direct_pay_evaluate(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 9. claim
CREATE OR REPLACE FUNCTION public.direct_pay_claim(p_rent_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  c_max_live_holds constant int := 3;   -- stops one partner hiding the pool; owner may change
  v_uid uuid := auth.uid();
  v_id uuid;
  v_plan record;
  v_ld record;
  v_fee numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT public._direct_pay_on() THEN RETURN jsonb_build_object('ok', false, 'code', 'not_available'); END IF;
  IF NOT public.psm_is_partner(v_uid) THEN RETURN jsonb_build_object('ok', false, 'code', 'not_partner'); END IF;
  IF p_rent_request_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid'); END IF;
  -- Same rule as option 1: no capital is deployed before the partnership agreement is signed.
  IF NOT public.funder_has_signed_agreement(v_uid) THEN RETURN jsonb_build_object('ok', false, 'code', 'agreement_required'); END IF;

  PERFORM public._direct_pay_plan_lock(p_rent_request_id);

  -- Stale holds on this plan end now (the scheduled job sends their messages).
  UPDATE public.funder_offplatform_rent_payments
     SET status = 'expired', expired_at = now(),
         cover_fee_status = CASE WHEN cover_fee_status = 'awaiting_confirmation' THEN 'waived' ELSE cover_fee_status END
   WHERE rent_request_id = p_rent_request_id AND flow = 'direct_pay' AND status = 'held' AND hold_expires_at <= now();

  -- Same partner, same plan: hand back the hold they already have.
  SELECT id INTO v_id FROM public.funder_offplatform_rent_payments
   WHERE rent_request_id = p_rent_request_id AND flow = 'direct_pay' AND funder_id = v_uid
     AND status IN ('held', 'pending');
  IF v_id IS NOT NULL THEN RETURN public._direct_pay_partner_view(v_id); END IF;

  IF (SELECT count(*) FROM public.funder_offplatform_rent_payments
       WHERE funder_id = v_uid AND flow = 'direct_pay' AND status = 'held' AND hold_expires_at > now()) >= c_max_live_holds THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_many_holds', 'max', c_max_live_holds);
  END IF;

  -- Same rules as option 1: the plan must be in the partner pool and free.
  SELECT p.rent_request_id, p.rent_amount, p.held_by, rr.landlord_id,
         COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
    INTO v_plan
    FROM public.v_partner_self_fundable_plans p
    JOIN public.rent_requests rr ON rr.id = p.rent_request_id
   WHERE p.rent_request_id = p_rent_request_id;
  IF NOT FOUND OR v_plan.held_by IS NOT NULL
     OR public.psm_plan_booked_for_other(p_rent_request_id, v_uid)
     OR public.psm_plan_partner_reserved_stage(p_rent_request_id) IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'taken');
  END IF;

  IF public._direct_pay_tenant_owes(p_rent_request_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'tenant_still_owes');
  END IF;

  -- Verified numbers only: the same three rules the landlord payout check uses.
  SELECT ld.name, ld.verified, ld.phone, NULLIF(btrim(ld.verified_mobile_money_number), '') AS number
    INTO v_ld FROM public.landlords ld WHERE ld.id = v_plan.landlord_id;
  IF v_ld.number IS NULL OR v_ld.verified IS NOT TRUE
     OR length(COALESCE(public.landlord_number_norm(v_ld.number), '')) < 9
     OR (length(COALESCE(public.landlord_number_norm(v_ld.phone), '')) >= 9
         AND public.landlord_number_norm(v_ld.phone) <> public.landlord_number_norm(v_ld.number)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'landlord_not_verified');
  END IF;

  -- Already being paid through option 1, or recalled there in the last 30 days.
  IF EXISTS (SELECT 1 FROM public.landlord_payouts l WHERE l.rent_request_id = p_rent_request_id
               AND l.status IN ('otp_verified','pending_merchant_payout','pending_finops_disbursement','disbursing',
                                'awaiting_agent_receipt','completed'))
     OR EXISTS (SELECT 1 FROM public.self_support_landlord_payments s
                 WHERE s.rent_request_id = p_rent_request_id AND s.created_at > now() - interval '30 days') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'taken');
  END IF;

  v_fee := GREATEST(0, COALESCE(public.self_support_proxy_fee(v_plan.rent_amount), 0));
  IF public.funder_float_available(v_uid) < v_fee THEN
    RETURN jsonb_build_object('ok', false, 'code', 'float_short', 'cover_fee', v_fee,
                              'float_available', public.funder_float_available(v_uid),
                              'float_short', v_fee - public.funder_float_available(v_uid));
  END IF;

  BEGIN
    INSERT INTO public.funder_offplatform_rent_payments (
      funder_id, rent_request_id, method, amount, status, flow, hold_started_at, hold_expires_at,
      landlord_id, landlord_phone, agent_id, cover_fee_amount, cover_fee_status)
    VALUES (v_uid, p_rent_request_id, 'mobile_money', v_plan.rent_amount, 'held', 'direct_pay', now(), now() + interval '48 hours',
            v_plan.landlord_id, v_ld.number, v_plan.agent_id, v_fee,
            CASE WHEN v_fee > 0 THEN 'awaiting_confirmation' ELSE 'none' END)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'taken');
  END;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'direct_pay_claim', 'funder_offplatform_rent_payments', v_id::text, 'direct_pay_claim',
          'Partner holds the Rent Plan for 48 hours to pay the landlord directly',
          jsonb_build_object('rent_request_id', p_rent_request_id, 'amount', v_plan.rent_amount, 'cover_fee', v_fee));
  RETURN public._direct_pay_partner_view(v_id);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_claim(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_claim(uuid) TO authenticated;

-- ---------------------------------------------------------------- 10. release (before any proof)
CREATE OR REPLACE FUNCTION public.direct_pay_release(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_uid uuid := auth.uid();
  p public.funder_offplatform_rent_payments%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  SELECT * INTO p FROM public.funder_offplatform_rent_payments
   WHERE id = p_payment_id AND flow = 'direct_pay' AND funder_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF p.status <> 'held' THEN RETURN public._direct_pay_partner_view(p.id, 'not_held'); END IF;
  -- Once an SMS is uploaded the partner has paid: only Landlord Ops can close it.
  IF EXISTS (SELECT 1 FROM public.funder_offplatform_rent_proofs WHERE payment_id = p.id) THEN
    RETURN public._direct_pay_partner_view(p.id, 'has_proofs');
  END IF;
  UPDATE public.funder_offplatform_rent_payments
     SET status = 'expired', expired_at = now(),
         cover_fee_status = CASE WHEN cover_fee_status = 'awaiting_confirmation' THEN 'waived' ELSE cover_fee_status END
   WHERE id = p.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'direct_pay_release', 'funder_offplatform_rent_payments', p.id::text, 'direct_pay_release',
          'Partner released the hold before paying', jsonb_build_object('rent_request_id', p.rent_request_id));
  RETURN public._direct_pay_partner_view(p.id);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_release(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_release(uuid) TO authenticated;

-- ---------------------------------------------------------------- 11. record a proof (edge function only)
-- p_read: what the server read from the image, e.g.
--   {"status":"read","tid":"MP231113.1234","amount":450000,"phone":"0772123456","paid_at":"2026-11-17T10:00:00+03:00","confidence":"high"}
-- status is read | unreadable | error. Values the browser sends never reach here: only the edge function calls this.
CREATE OR REPLACE FUNCTION public.direct_pay_record_proof(
  p_partner uuid, p_payment_id uuid, p_photo_path text, p_photo_sha256 text, p_provider text,
  p_tid_typed text, p_amount_typed numeric, p_read jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  c_max_proofs constant int := 5;
  p public.funder_offplatform_rent_payments%ROWTYPE;
  v_read_status text := COALESCE(p_read->>'status', 'error');
  v_amount_read numeric;
  v_tid_norm text;
  v_paid_at timestamptz;
BEGIN
  IF p_partner IS NULL OR p_payment_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid'); END IF;
  SELECT * INTO p FROM public.funder_offplatform_rent_payments
   WHERE id = p_payment_id AND flow = 'direct_pay' AND funder_id = p_partner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;

  IF p.status = 'held' AND p.hold_expires_at <= now() THEN
    RETURN public._direct_pay_evaluate(p.id);   -- ends the hold and says so
  END IF;
  IF p.status <> 'held' THEN RETURN public._direct_pay_partner_view(p.id, 'not_held'); END IF;

  IF p_photo_path IS NULL OR p_photo_path NOT LIKE p_partner::text || '/%' THEN
    RETURN public._direct_pay_partner_view(p.id, 'invalid_photo');
  END IF;
  IF (SELECT count(*) FROM public.funder_offplatform_rent_proofs WHERE payment_id = p.id) >= c_max_proofs THEN
    RETURN public._direct_pay_partner_view(p.id, 'too_many_proofs');
  END IF;
  IF v_read_status NOT IN ('read', 'unreadable', 'error') THEN v_read_status := 'error'; END IF;

  v_amount_read := CASE WHEN jsonb_typeof(p_read->'amount') = 'number' AND (p_read->>'amount')::numeric > 0
                        THEN (p_read->>'amount')::numeric END;
  v_tid_norm := public.normalize_momo_tid(COALESCE(NULLIF(btrim(p_tid_typed), ''), p_read->>'tid'));
  IF v_tid_norm IS NULL THEN RETURN public._direct_pay_partner_view(p.id, 'tid_missing'); END IF;
  IF COALESCE(v_amount_read, CASE WHEN p_amount_typed > 0 THEN p_amount_typed END) IS NULL THEN
    RETURN public._direct_pay_partner_view(p.id, 'amount_missing');
  END IF;

  -- The same SMS twice inside one payment would count its amount twice.
  IF EXISTS (SELECT 1 FROM public.funder_offplatform_rent_proofs f
              WHERE f.payment_id = p.id AND (f.tid_norm = v_tid_norm
                    OR (p_photo_sha256 IS NOT NULL AND f.photo_sha256 = p_photo_sha256))) THEN
    RETURN public._direct_pay_partner_view(p.id, 'same_proof_again');
  END IF;

  BEGIN
    v_paid_at := NULLIF(p_read->>'paid_at', '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_paid_at := NULL;
  END;

  INSERT INTO public.funder_offplatform_rent_proofs (
    payment_id, partner_id, photo_path, photo_sha256, provider, tid_typed, tid_read,
    amount_read, amount_typed, recipient_read, paid_at_read, reader_status, reader_confidence)
  VALUES (p.id, p_partner, p_photo_path, NULLIF(btrim(p_photo_sha256), ''),
          CASE WHEN p_provider IN ('mtn', 'airtel') THEN p_provider END,
          NULLIF(btrim(p_tid_typed), ''), NULLIF(btrim(p_read->>'tid'), ''),
          v_amount_read, CASE WHEN p_amount_typed > 0 THEN p_amount_typed END,
          NULLIF(btrim(p_read->>'phone'), ''), v_paid_at,
          CASE WHEN v_read_status = 'read' AND v_amount_read IS NULL THEN 'unreadable' ELSE v_read_status END,
          CASE p_read->>'confidence' WHEN 'high' THEN 1 WHEN 'low' THEN 0.5 END);

  RETURN public._direct_pay_evaluate(p.id);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_record_proof(uuid, uuid, text, text, text, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.direct_pay_record_proof(uuid, uuid, text, text, text, text, numeric, jsonb) TO service_role;

-- ---------------------------------------------------------------- 12. refresh and list (partner)
CREATE OR REPLACE FUNCTION public.direct_pay_refresh(p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  SELECT id INTO v_id FROM public.funder_offplatform_rent_payments
   WHERE id = p_payment_id AND flow = 'direct_pay' AND funder_id = v_uid FOR UPDATE;
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  RETURN public._direct_pay_evaluate(v_id);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_refresh(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_refresh(uuid) TO authenticated;

-- Live ones first, then the 20 most recent closed ones. One query; proofs come aggregated per payment.
CREATE OR REPLACE FUNCTION public.direct_pay_my_payments()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(public._direct_pay_partner_view(x.id) ORDER BY x.live DESC, x.created_at DESC)
      FROM (
        SELECT p.id, p.created_at, (p.status IN ('held', 'pending')) AS live,
               row_number() OVER (PARTITION BY p.status IN ('held', 'pending') ORDER BY p.created_at DESC) AS rn
          FROM public.funder_offplatform_rent_payments p
         WHERE p.funder_id = v_uid AND p.flow = 'direct_pay'
      ) x
     WHERE x.live OR x.rn <= 20), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.direct_pay_my_payments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.direct_pay_my_payments() TO authenticated;

-- ---------------------------------------------------------------- 13. post-checks
DO $check$
BEGIN
  IF pg_get_viewdef('public.v_partner_self_fundable_plans'::regclass) NOT LIKE '%funder_offplatform_rent_payments%' THEN
    RAISE EXCEPTION 'direct pay phase 2: the pool view was not updated';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.psm_plan_partner_reserved_stage(uuid)'::regprocedure) NOT LIKE '%direct_pay_held%' THEN
    RAISE EXCEPTION 'direct pay phase 2: the reserved stage was not updated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_function_privilege('authenticated', 'public.direct_pay_record_proof(uuid, uuid, text, text, text, text, numeric, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'direct pay phase 2: the browser must not be able to call direct_pay_record_proof';
  END IF;
END
$check$;
