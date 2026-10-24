-- 2026-10-24: Partner Return duplicate-payment prevention (CFO request, after the 24 Oct duplicate audit).
-- PREPARED FOR REVIEW. NOT APPLIED. This migration moves no money and changes no existing financial record.
--
-- THE DEFECT
--   A portfolio's Return cycle was identified by the exact text of investor_portfolios.next_roi_date at the moment
--   of payment (key roi-cycle-<portfolio>-<date>). Staff can edit that date, change the payout day, or move it by
--   compounding, so the same month produced a new key (2026-09-10, then 2026-09-11) and was paid again. Also:
--     * enforce_roi_cycle_once checked "already paid" without a lock, so two requests at once could both pass;
--     * any request carrying metadata.correction_key skipped the check, with no authorisation and no audit;
--     * compounding and split Returns (post_portfolio_roi_ledger) checked no cycle at all.
--
-- THE FIX
--   1. A cycle is the CALENDAR MONTH of the scheduled Return date: (portfolio, cycle_month). Edits to next_roi_date
--      inside a month no longer create a new cycle.
--   2. Every Return for a portfolio cycle reserves a row in portfolio_return_cycle_claims BEFORE any money moves:
--        - a payout request (pending_wallet_operations insert, any screen or function)   kind 'payout'
--        - a compound (post_portfolio_roi_ledger 'compound')                              kind 'compound'
--        - a split (post_portfolio_roi_ledger 'split_*'; its cash portion request joins the same claim) kind 'split'
--      Reservation runs under a per-portfolio advisory lock, and a partial unique index allows one active claim per
--      (portfolio, cycle_month) — so concurrent requests, retries, other descriptions and other execution dates
--      cannot produce a second one. A retry with the same reference reuses its own claim.
--   3. A claim is also refused (unless overridden) when the cycle is more than 7 days in the future, when an
--      adjacent month already has a Return less than 20 days away (a date edit that crossed a month boundary), or
--      when the month is before 2026-08 (ledger history before keyed payouts is not reliable enough to prove the
--      cycle unpaid). Ledger credits keyed under the old roi-cycle-<portfolio>-<date> scheme count as paid.
--   4. Ledger backstop: a portfolio Return wallet credit (roi_wallet_credit, wallet, cash_in) or reinvestment
--      (roi_reinvestment, cash_in) must carry the key return-cycle:<active claim>:<cash|retained|reinvest>.
--      create_ledger_transaction already returns the existing group for a used key, so one claim leg posts once.
--   5. Exceptional extra payment: the CFO approver authorises a single-use override for one portfolio and month,
--      naming the one staff member who may use it (never the authoriser), with a reason (20+ characters), valid
--      24 hours, audited in audit_logs (authorised / used / revoked). It is used only when the request is made. AUTHORISING AN OVERRIDE PAYS NOTHING; the payment still has to be
--      requested and approved through the normal chain.
--   7. Compound and split: the posting and the portfolio change (principal / next date / total Returns earned)
--      happen in ONE transaction inside post_portfolio_roi_ledger; a retry posts and changes nothing.
--   8. Returns posted before this migration without any cycle key block their posting month (read only).
--   6. A claim is released only when its request is rejected or cancelled AND nothing was posted under it, or the
--      posted credit was reversed by reverse-proxy-roi-approval. A split claim is never released automatically.
--
-- NOT COVERED (see the review notes): cfo-direct-credit / scheduled payouts that post a Return-category credit not
-- linked to a portfolio; rent-facilitation rewards (process-supporter-roi, own key per payment); self-managed
-- partner cycles (pay_partner_self_cycles, own cycle table); compounds and splits posted before this migration
-- (no cycle recorded, so not counted).
--
-- Replaces two live functions; preconditions pin their exact production bodies (2026-10-24) so this refuses to run
-- over anything that changed since. New functions are closed by default and granted explicitly below.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;). The precondition changes nothing when it refuses.
-- DEPLOY ORDER: apply this, then deploy approve-wallet-operation from the same commit. Until the function is
-- deployed, the old function's credits are refused by the ledger backstop (fails closed: nothing is paid twice,
-- approvals simply wait).
-- Rollback: supabase/rollbacks/20261024140000_return_cycle_guard.rollback.sql

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.portfolio_return_cycle_claims') IS NOT NULL
     OR to_regclass('public.portfolio_return_cycle_overrides') IS NOT NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.enforce_roi_cycle_once()'::regprocedure)
          IS DISTINCT FROM '18ff622041302b9f25c9d174f8f819c5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = 'public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text)'::regprocedure)
          IS DISTINCT FROM '6313f826f8dc023c5b66a4c8bdcba6ff'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.create_ledger_transaction(jsonb,text,boolean)'::regprocedure)
          IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR to_regprocedure('public.is_cfo_approver(uuid)') IS NULL
     OR to_regprocedure('public._ledger_can_post_partner_returns(uuid)') IS NULL
     OR to_regprocedure('public.staff_mfa_ok()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: the Return cycle tables already exist, or a function this replaces changed since 2026-10-24; nothing was changed';
  END IF;
END
$pre$;

-- ── Tables ────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.portfolio_return_cycle_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id      uuid NOT NULL REFERENCES public.investor_portfolios(id),
  cycle_month       date NOT NULL CHECK (cycle_month = date_trunc('month', cycle_month)::date),
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 20 AND length(reason) <= 1000),
  authorised_by     uuid NOT NULL,
  requester_id      uuid NOT NULL,      -- the only person who may use it; never the authoriser
  authorised_at     timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  consumed_at       timestamptz,
  consumed_claim_id uuid,
  revoked_at        timestamptz,
  revoked_by        uuid,
  revoke_reason     text,
  CHECK (requester_id <> authorised_by)
);
COMMENT ON TABLE public.portfolio_return_cycle_overrides IS
  'Single-use CFO authorisation for an exceptional extra Return in a portfolio cycle. Authorising pays nothing.';

CREATE TABLE public.portfolio_return_cycle_claims (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id         uuid NOT NULL REFERENCES public.investor_portfolios(id),
  cycle_month          date NOT NULL CHECK (cycle_month = date_trunc('month', cycle_month)::date),
  cycle_date           date NOT NULL,
  claim_seq            integer NOT NULL DEFAULT 0 CHECK (claim_seq >= 0),
  kind                 text NOT NULL CHECK (kind IN ('payout', 'split', 'compound')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  source               text NOT NULL,
  reference            text,
  pending_operation_id uuid,
  override_id          uuid REFERENCES public.portfolio_return_cycle_overrides(id),
  claimed_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  released_at          timestamptz,
  released_by          uuid,
  release_reason       text,
  CHECK ((claim_seq = 0) OR (override_id IS NOT NULL)),
  CHECK ((status = 'released') = (released_at IS NOT NULL))
);
COMMENT ON TABLE public.portfolio_return_cycle_claims IS
  'One active row per portfolio Return cycle (calendar month). Ledger Return legs must carry return-cycle:<id>:<leg>.';

-- The concurrency guarantee: one active claim per portfolio, month and sequence. Normal claims are sequence 0;
-- only an authorised override can add sequence 1, 2, ...
CREATE UNIQUE INDEX portfolio_return_cycle_claims_one_active
  ON public.portfolio_return_cycle_claims (portfolio_id, cycle_month, claim_seq) WHERE status = 'active';
CREATE INDEX portfolio_return_cycle_claims_pending_op
  ON public.portfolio_return_cycle_claims (pending_operation_id) WHERE pending_operation_id IS NOT NULL;
CREATE INDEX portfolio_return_cycle_claims_reference
  ON public.portfolio_return_cycle_claims (portfolio_id, reference) WHERE status = 'active';
CREATE INDEX portfolio_return_cycle_overrides_lookup
  ON public.portfolio_return_cycle_overrides (portfolio_id, cycle_month);

ALTER TABLE public.portfolio_return_cycle_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_return_cycle_overrides ENABLE ROW LEVEL SECURITY;

-- Read-only for the staff who request and approve Returns. All writes go through the SECURITY DEFINER functions.
CREATE POLICY return_cycle_claims_staff_read ON public.portfolio_return_cycle_claims
  FOR SELECT TO authenticated
  USING (public.is_cfo_approver(auth.uid()) OR public._ledger_can_post_partner_returns(auth.uid()));
CREATE POLICY return_cycle_overrides_staff_read ON public.portfolio_return_cycle_overrides
  FOR SELECT TO authenticated
  USING (public.is_cfo_approver(auth.uid()) OR public._ledger_can_post_partner_returns(auth.uid()));
CREATE POLICY mfa_required_for_staff ON public.portfolio_return_cycle_claims AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.portfolio_return_cycle_overrides AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

REVOKE ALL ON public.portfolio_return_cycle_claims, public.portfolio_return_cycle_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.portfolio_return_cycle_claims, public.portfolio_return_cycle_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_return_cycle_claims, public.portfolio_return_cycle_overrides TO service_role;

-- Staff who may request a Partner Return (COO page users): the Returns-posting staff, plus the manager / COO /
-- partner-ops roles whose row policies let them queue a payout request.
CREATE FUNCTION public._return_cycle_can_request(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT _user_id IS NOT NULL AND (
    public._ledger_can_post_partner_returns(_user_id)
    OR EXISTS (SELECT 1 FROM public.user_roles ur
                WHERE ur.user_id = _user_id AND ur.role::text IN ('manager', 'coo', 'partner_ops', 'super_admin')
                  AND coalesce(ur.enabled, true)))
$function$;

-- ── Core: reserve a cycle ─────────────────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public._claim_return_cycle(
  p_portfolio_id uuid, p_cycle_date date, p_kind text, p_source text, p_reference text,
  p_pending_operation_id uuid, p_override_id uuid, p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_early_days   CONSTANT integer := 7;
  c_min_spacing  CONSTANT integer := 20;
  c_reliable_from CONSTANT date := DATE '2026-08-01';
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_pf      record;
  v_cycle   date;
  v_month   date;
  v_claim   uuid;
  v_ovr     record;
  v_seq     integer := 0;
  v_reasons text[] := ARRAY[]::text[];
  v_legacy  constant text := 'roi-cycle-' || p_portfolio_id::text || '-';
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('payout', 'split', 'compound') THEN
    RAISE EXCEPTION 'Unknown Return cycle kind' USING ERRCODE = '22023'; END IF;

  SELECT id, portfolio_code, next_roi_date INTO v_pf FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;

  v_cycle := coalesce(p_cycle_date, v_pf.next_roi_date, v_today);
  v_month := date_trunc('month', v_cycle)::date;

  -- Serialise every Return reservation for this portfolio (all months), so the checks below and the insert are one
  -- step. The unique index is the second lock.
  PERFORM pg_advisory_xact_lock(hashtext('return-cycle'), hashtext(p_portfolio_id::text));

  -- A retry of the same request (same reference, or the same queued payout) gets its own claim back.
  IF p_pending_operation_id IS NOT NULL THEN
    SELECT id INTO v_claim FROM public.portfolio_return_cycle_claims
     WHERE pending_operation_id = p_pending_operation_id AND status = 'active' AND portfolio_id = p_portfolio_id;
    IF FOUND THEN RETURN v_claim; END IF;
  END IF;
  IF p_reference IS NOT NULL AND p_pending_operation_id IS NULL THEN
    SELECT id INTO v_claim FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_portfolio_id AND status = 'active' AND reference = p_reference
       AND kind = p_kind AND cycle_month = v_month;
    IF FOUND THEN RETURN v_claim; END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.portfolio_return_cycle_claims
              WHERE portfolio_id = p_portfolio_id AND cycle_month = v_month AND status = 'active') THEN
    v_reasons := array_append(v_reasons, 'already_claimed');
  END IF;

  -- Credits posted under the previous key scheme count as paid unless the payout was reversed.
  IF EXISTS (SELECT 1 FROM public.general_ledger g
              WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id
                AND g.direction = 'cash_in' AND g.category IN ('roi_wallet_credit', 'roi_reinvestment')
                AND g.idempotency_key ~ ('^' || v_legacy || '[0-9]{4}-[0-9]{2}-[0-9]{2}$')
                AND date_trunc('month', right(g.idempotency_key, 10)::date) = v_month
                AND NOT EXISTS (SELECT 1 FROM public.pending_wallet_operations o
                                 WHERE o.reference_id = g.reference_id AND o.status = 'cancelled'
                                   AND o.metadata ? 'reversed_at')) THEN
    v_reasons := array_append(v_reasons, 'already_paid');
  END IF;

  IF EXISTS (SELECT 1 FROM public.portfolio_return_cycle_claims
              WHERE portfolio_id = p_portfolio_id AND status = 'active' AND cycle_month <> v_month
                AND abs(cycle_date - v_cycle) < c_min_spacing)
     OR EXISTS (SELECT 1 FROM public.general_ledger g
                 WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id
                   AND g.direction = 'cash_in' AND g.category IN ('roi_wallet_credit', 'roi_reinvestment')
                   AND g.idempotency_key ~ ('^' || v_legacy || '[0-9]{4}-[0-9]{2}-[0-9]{2}$')
                   AND date_trunc('month', right(g.idempotency_key, 10)::date) <> v_month
                   AND abs(right(g.idempotency_key, 10)::date - v_cycle) < c_min_spacing
                   AND NOT EXISTS (SELECT 1 FROM public.pending_wallet_operations o
                                    WHERE o.reference_id = g.reference_id AND o.status = 'cancelled'
                                      AND o.metadata ? 'reversed_at')) THEN
    v_reasons := array_append(v_reasons, 'too_close_to_another_cycle');
  END IF;

  -- Returns posted before this migration without any cycle key (compounds, split parts, null-key credits) cannot be
  -- tied to a cycle exactly. One posted in the target month blocks it (without an override): the protection errs on
  -- the side of refusing; historical records are only read, never changed.
  IF EXISTS (SELECT 1 FROM public.general_ledger g
              WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id AND g.direction = 'cash_in'
                AND ((g.category = 'roi_wallet_credit' AND coalesce(g.ledger_scope, 'wallet') = 'wallet')
                     OR (g.category = 'roi_reinvestment' AND coalesce(g.linked_party, '') <> 'platform'))
                AND (g.idempotency_key IS NULL OR g.idempotency_key LIKE 'portfolio-roi-ledger:%')
                AND date_trunc('month', (g.transaction_date AT TIME ZONE 'Africa/Kampala'))::date = v_month) THEN
    v_reasons := array_append(v_reasons, 'unkeyed_return_this_month');
  END IF;

  IF v_cycle > v_today + c_early_days THEN v_reasons := array_append(v_reasons, 'not_yet_due'); END IF;
  IF v_month < c_reliable_from THEN v_reasons := array_append(v_reasons, 'before_reliable_history'); END IF;

  IF cardinality(v_reasons) > 0 THEN
    IF p_override_id IS NULL THEN
      RAISE EXCEPTION 'Duplicate Return blocked: portfolio % (%): % for the % cycle.',
          coalesce(v_pf.portfolio_code, p_portfolio_id::text), array_to_string(v_reasons, ', '),
          CASE WHEN 'already_claimed' = ANY (v_reasons) OR 'already_paid' = ANY (v_reasons)
               THEN 'a Return already exists' ELSE 'this Return cannot be paid without an override' END,
          to_char(v_month, 'FMMonth YYYY')
        -- 23505 unique_violation = the cycle already has a Return; 23514 check_violation = refused for another reason.
        USING ERRCODE = CASE WHEN 'already_claimed' = ANY (v_reasons) OR 'already_paid' = ANY (v_reasons)
                             THEN '23505' ELSE '23514' END,
              DETAIL = array_to_string(v_reasons, ','),
              HINT = 'An exceptional extra Return needs a CFO-authorised override for this portfolio and month.';
    END IF;

    SELECT * INTO v_ovr FROM public.portfolio_return_cycle_overrides WHERE id = p_override_id FOR UPDATE;
    IF NOT FOUND OR v_ovr.portfolio_id <> p_portfolio_id OR v_ovr.cycle_month <> v_month THEN
      RAISE EXCEPTION 'Override does not match this portfolio and Return cycle' USING ERRCODE = '42501'; END IF;
    IF v_ovr.consumed_at IS NOT NULL OR v_ovr.revoked_at IS NOT NULL OR v_ovr.expires_at <= now() THEN
      RAISE EXCEPTION 'Override is used, revoked or expired' USING ERRCODE = '42501'; END IF;
    IF NOT public.is_cfo_approver(v_ovr.authorised_by) THEN
      RAISE EXCEPTION 'Override was not authorised by a current CFO approver' USING ERRCODE = '42501'; END IF;
    IF p_actor IS NULL OR v_ovr.authorised_by = p_actor THEN
      RAISE EXCEPTION 'The person who authorised the override cannot also request the Return' USING ERRCODE = '42501'; END IF;
    IF v_ovr.requester_id <> p_actor OR NOT public._return_cycle_can_request(p_actor) THEN
      RAISE EXCEPTION 'This override was authorised for another requester' USING ERRCODE = '42501'; END IF;

    SELECT coalesce(max(claim_seq), -1) + 1 INTO v_seq FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_portfolio_id AND cycle_month = v_month AND status = 'active';
  ELSIF p_override_id IS NOT NULL THEN
    RAISE EXCEPTION 'No override is needed: this Return cycle is unpaid. The override was not used.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.portfolio_return_cycle_claims
    (portfolio_id, cycle_month, cycle_date, claim_seq, kind, source, reference, pending_operation_id, override_id, claimed_by)
  VALUES (p_portfolio_id, v_month, v_cycle, v_seq, p_kind, p_source, p_reference, p_pending_operation_id, p_override_id, p_actor)
  RETURNING id INTO v_claim;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.portfolio_return_cycle_overrides SET consumed_at = now(), consumed_claim_id = v_claim WHERE id = p_override_id;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
    VALUES (p_actor, 'return_cycle_override_used', 'portfolio_return_cycle_claims', v_claim::text,
            jsonb_build_object('portfolio_id', p_portfolio_id, 'cycle_month', v_month, 'override_id', p_override_id,
                               'authorised_by', v_ovr.authorised_by, 'blocked_reasons', v_reasons, 'source', p_source),
            v_ovr.reason);
  END IF;

  RETURN v_claim;
END
$function$;

-- Turns a queued payout request into a claim (or joins its split). Used by the request trigger and by approval.
-- p_at_approval: the request was queued earlier (before this migration) and is only now being reserved.
CREATE FUNCTION public._return_cycle_claim_for_operation_row(p_op public.pending_wallet_operations, p_at_approval boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claim uuid;
  v_cycle date;
  v_override uuid;
  v_actor uuid;
BEGIN
  IF coalesce(p_op.operation_type, '') LIKE 'roi_split\_%' THEN
    -- The cash portion of a split joins the claim its split posting made (same reference, same portfolio).
    SELECT id INTO v_claim FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_op.source_id AND status = 'active' AND kind = 'split' AND reference = p_op.reference_id
       AND (pending_operation_id IS NULL OR pending_operation_id = p_op.id)
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Split cash portion % has no matching split Return for this portfolio', p_op.reference_id
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.portfolio_return_cycle_claims SET pending_operation_id = p_op.id WHERE id = v_claim;
    RETURN v_claim;
  END IF;

  IF nullif(btrim(coalesce(p_op.metadata ->> 'correction_key', '')), '') IS NOT NULL
     AND nullif(btrim(coalesce(p_op.metadata ->> 'override_id', '')), '') IS NULL THEN
    RAISE EXCEPTION 'A correction Return needs a CFO-authorised override; correction_key alone is no longer accepted'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_cycle := nullif(btrim(coalesce(p_op.metadata ->> 'cycle_anchor', '')), '')::date;
    v_override := nullif(btrim(coalesce(p_op.metadata ->> 'override_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid cycle_anchor or override_id on the Return request' USING ERRCODE = '22023';
  END;
  v_actor := coalesce(auth.uid(), nullif(p_op.metadata ->> 'initiated_by', '')::uuid);
  IF p_at_approval AND v_override IS NOT NULL THEN
    RAISE EXCEPTION 'An override is used when the Return is requested, by its named requester, not at approval'
      USING ERRCODE = '42501';
  END IF;

  -- A request queued before this guard that does not name its cycle would otherwise be read against next_roi_date
  -- as it is NOW. If the portfolio received any Return after the request was made, that date has already moved on and
  -- the request would pay next month's Return early (the 7-8 July pattern). Refuse it; re-request it for its cycle.
  IF p_at_approval AND v_cycle IS NULL AND v_override IS NULL AND (
       EXISTS (SELECT 1 FROM public.portfolio_return_cycle_claims c
                WHERE c.portfolio_id = p_op.source_id AND c.status = 'active' AND c.created_at >= p_op.created_at
                  AND c.pending_operation_id IS DISTINCT FROM p_op.id)
    OR EXISTS (SELECT 1 FROM public.general_ledger g
                WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_op.source_id AND g.direction = 'cash_in'
                  AND g.created_at >= p_op.created_at
                  AND (g.category = 'roi_wallet_credit'
                       OR (g.category = 'roi_reinvestment' AND coalesce(g.linked_party, '') <> 'platform')))) THEN
    RAISE EXCEPTION 'Duplicate Return blocked: portfolio % received a Return after this request was made, and the request does not name its cycle. Re-request it for the cycle it is meant to pay.', p_op.source_id
      USING ERRCODE = '23505';
  END IF;

  RETURN public._claim_return_cycle(p_op.source_id, v_cycle, 'payout', 'pending_wallet_operation',
                                    p_op.reference_id, p_op.id, v_override, v_actor);
END
$function$;

-- ── Payout requests (every screen and function that queues a Return payout) ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_roi_cycle_once()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claim uuid;
  v_month date;
BEGIN
  -- A Partner Return payout must name its portfolio, or no cycle could be reserved for it. (Rent-facilitation rewards
  -- use supporter_platform_rewards against supporter_roi_payments, one per payment, and stay as they are.)
  IF NEW.category = 'roi_payout' AND (NEW.source_table IS DISTINCT FROM 'investor_portfolios' OR NEW.source_id IS NULL) THEN
    RAISE EXCEPTION 'A Partner Return payout request must name its portfolio' USING ERRCODE = '23514';
  END IF;
  IF coalesce(NEW.category, '') NOT IN ('roi_payout', 'supporter_platform_rewards')
     OR NEW.source_table IS DISTINCT FROM 'investor_portfolios'
     OR NEW.source_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('return-cycle'), hashtext(NEW.source_id::text));

  -- One open request per portfolio (unchanged rule), except a split's own cash portion and an overridden request.
  IF coalesce(NEW.operation_type, '') NOT LIKE 'roi_split\_%'
     AND nullif(btrim(coalesce(NEW.metadata ->> 'override_id', '')), '') IS NULL
     AND EXISTS (SELECT 1 FROM public.pending_wallet_operations pwo
                  WHERE pwo.source_id = NEW.source_id AND pwo.source_table = 'investor_portfolios'
                    AND pwo.category IN ('roi_payout', 'supporter_platform_rewards')
                    AND pwo.status IN ('pending', 'pending_coo_approval', 'coo_approved', 'awaiting_verification')
                    AND pwo.id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'Duplicate Return blocked: portfolio % already has a Return payout awaiting approval.', NEW.source_id
      USING ERRCODE = 'unique_violation';
  END IF;

  v_claim := public._return_cycle_claim_for_operation_row(NEW);
  SELECT cycle_month INTO v_month FROM public.portfolio_return_cycle_claims WHERE id = v_claim;
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb)
    || jsonb_build_object('return_cycle_claim_id', v_claim, 'return_cycle_month', v_month);
  RETURN NEW;
END;
$function$;

-- Approval step (service role only): the claim this request holds, created now for a request queued before this
-- migration. Refuses when the request no longer matches its claim.
CREATE FUNCTION public.claim_return_cycle_for_operation(p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_op public.pending_wallet_operations;
  v_claim public.portfolio_return_cycle_claims;
  v_claim_id uuid;
  v_key text;
  v_current date;
BEGIN
  SELECT * INTO v_op FROM public.pending_wallet_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operation not found' USING ERRCODE = 'P0002'; END IF;
  IF coalesce(v_op.category, '') NOT IN ('roi_payout', 'supporter_platform_rewards')
     OR v_op.source_table IS DISTINCT FROM 'investor_portfolios' OR v_op.source_id IS NULL THEN
    RETURN jsonb_build_object('applies', false);
  END IF;

  SELECT * INTO v_claim FROM public.portfolio_return_cycle_claims
   WHERE pending_operation_id = p_operation_id AND status = 'active'
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtext('return-cycle'), hashtext(v_op.source_id::text));
    v_claim_id := public._return_cycle_claim_for_operation_row(v_op, true);
    SELECT * INTO v_claim FROM public.portfolio_return_cycle_claims WHERE id = v_claim_id;
  END IF;

  IF v_claim.portfolio_id <> v_op.source_id THEN
    RAISE EXCEPTION 'Return request % no longer matches the portfolio it reserved', p_operation_id USING ERRCODE = '42501';
  END IF;

  v_key := 'return-cycle:' || v_claim.id::text || ':cash';
  SELECT next_roi_date INTO v_current FROM public.investor_portfolios WHERE id = v_op.source_id;

  RETURN jsonb_build_object(
    'applies', true,
    'claim_id', v_claim.id,
    'kind', v_claim.kind,
    'cycle_date', v_claim.cycle_date,
    'cycle_month', v_claim.cycle_month,
    'claim_seq', v_claim.claim_seq,
    'ledger_key', v_key,
    'already_posted', EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_key),
    -- Paying an older (catch-up) cycle must not move the schedule past the current cycle.
    'advance_next_roi_date', v_current IS NULL OR v_claim.cycle_month >= date_trunc('month', v_current)::date);
END
$function$;

-- Release a payout claim when its request is rejected or cancelled and nothing stands posted under it.
CREATE FUNCTION public.release_return_cycle_claim_on_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c record;
  v_posted boolean;
  v_reversed boolean;
BEGIN
  IF coalesce(NEW.status, '') NOT IN ('rejected', 'cancelled') OR OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;

  v_reversed := EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = 'reverse-roi-approval-' || NEW.id::text);
  FOR c IN SELECT * FROM public.portfolio_return_cycle_claims
            WHERE pending_operation_id = NEW.id AND status = 'active' FOR UPDATE LOOP
    v_posted := EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = 'return-cycle:' || c.id::text || ':cash');
    IF c.kind = 'payout' AND (NOT v_posted OR v_reversed) THEN
      UPDATE public.portfolio_return_cycle_claims
         SET status = 'released', released_at = now(), released_by = auth.uid(),
             release_reason = CASE WHEN v_posted THEN 'Return reversed' ELSE 'request ' || NEW.status || ' before payment' END
       WHERE id = c.id;
    ELSIF c.kind = 'split' AND NOT v_posted THEN
      -- The split's retained or reinvested part stands, so the cycle stays used; the cash portion may be re-requested.
      UPDATE public.portfolio_return_cycle_claims SET pending_operation_id = NULL WHERE id = c.id;
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_release_return_cycle_claim
  AFTER UPDATE OF status ON public.pending_wallet_operations
  FOR EACH ROW EXECUTE FUNCTION public.release_return_cycle_claim_on_status();

-- ── Ledger backstop ───────────────────────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.enforce_return_cycle_ledger_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m text[];
  c record;
BEGIN
  IF NEW.source_table IS DISTINCT FROM 'investor_portfolios' OR NEW.direction IS DISTINCT FROM 'cash_in' THEN
    RETURN NEW;
  END IF;
  -- create_ledger_transaction treats a missing scope as 'wallet'; so does this check.
  IF NOT ((NEW.category = 'roi_wallet_credit' AND coalesce(NEW.ledger_scope, 'wallet') = 'wallet')
          -- rent-facilitation rewards auto-reinvested by process-supporter-roi carry linked_party 'platform' and
          -- their own per-payment key; they are not a portfolio Return cycle.
          OR (NEW.category = 'roi_reinvestment' AND coalesce(NEW.linked_party, '') <> 'platform')) IS TRUE THEN
    RETURN NEW;
  END IF;

  m := regexp_match(coalesce(NEW.idempotency_key, ''),
                    '^return-cycle:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(cash|retained|reinvest)$');
  IF m IS NULL THEN
    RAISE EXCEPTION 'Return for portfolio % has no Return cycle reservation; it was not posted.', NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO c FROM public.portfolio_return_cycle_claims WHERE id = m[1]::uuid;
  IF NOT FOUND OR c.status <> 'active' OR c.portfolio_id <> NEW.source_id
     OR (m[2] = 'cash' AND c.kind NOT IN ('payout', 'split'))
     OR (m[2] = 'retained' AND (c.kind <> 'split' OR NEW.category <> 'roi_wallet_credit'))
     OR (m[2] = 'reinvest' AND (c.kind NOT IN ('compound', 'split') OR NEW.category <> 'roi_reinvestment'))
     OR (m[2] IN ('cash', 'retained') AND NEW.category <> 'roi_wallet_credit') THEN
    RAISE EXCEPTION 'Return for portfolio % does not match an active Return cycle reservation; it was not posted.', NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_enforce_return_cycle_ledger_key
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enforce_return_cycle_ledger_key();

-- ── Compound and split Returns ────────────────────────────────────────────────────────────────────────────────────

-- Production body (2026-10-24) plus: the cycle reservation; a ledger key naming the claim; and, when
-- p_apply_portfolio, the portfolio change made IN THE SAME TRANSACTION as the posting (compound: principal + one
-- month on next_roi_date; split_reinvest: principal; split_keep_returns: total_roi_earned). So a compound or split
-- can no longer post without its portfolio change, or change the portfolio without posting.
-- A retry of the same reference finds its key already in the ledger and returns that group WITHOUT posting or
-- changing the portfolio again. Runs as the function owner, so the portfolio guards (which only restrict signed-in
-- owners editing their own portfolio) do not block it; the caller was already checked as Returns staff.
CREATE FUNCTION public._post_portfolio_roi_ledger_core(
  p_operation text, p_portfolio_id uuid, p_amount numeric, p_reference text, p_description_out text,
  p_description_in text, p_cycle_date date, p_override_id uuid, p_apply_portfolio boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_investor uuid; v_principal numeric; v_pct numeric; v_cycle_returns numeric; v_next date;
  v_recipient uuid; v_keep boolean; v_claim uuid; v_key text; v_group uuid; v_claim_month date;
BEGIN
  IF v_actor IS NULL OR NOT public._ledger_can_post_partner_returns(v_actor) THEN
    RAISE EXCEPTION 'Not authorised to post partner Returns' USING ERRCODE = '42501'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('compound', 'split_reinvest', 'split_keep_returns') THEN
    RAISE EXCEPTION 'Unknown Returns operation' USING ERRCODE = '22023'; END IF;
  IF p_reference IS NULL OR p_reference !~ '^(CMP|SPL)-[A-Z0-9]{4,20}-[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'Invalid Returns reference' USING ERRCODE = '22023'; END IF;
  IF length(coalesce(p_description_out, '')) > 2000 OR length(coalesce(p_description_in, '')) > 2000 THEN
    RAISE EXCEPTION 'Description too long' USING ERRCODE = '22023'; END IF;
  IF p_amount IS NULL OR p_amount < 1 OR p_amount <> round(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a whole number of at least 1' USING ERRCODE = '22023'; END IF;

  SELECT ip.investor_id, ip.investment_amount, ip.roi_percentage, ip.next_roi_date
    INTO v_investor, v_principal, v_pct, v_next
    FROM public.investor_portfolios ip WHERE ip.id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND OR v_investor IS NULL THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;

  v_claim := public._claim_return_cycle(p_portfolio_id, p_cycle_date,
                                        CASE WHEN p_operation = 'compound' THEN 'compound' ELSE 'split' END,
                                        'post_portfolio_roi_ledger', p_reference, NULL, p_override_id, v_actor);
  v_keep := p_operation = 'split_keep_returns';
  v_key := 'return-cycle:' || v_claim::text || ':' || CASE WHEN v_keep THEN 'retained' ELSE 'reinvest' END;

  -- Retry of a posting that already went through: return it, post nothing, change nothing.
  SELECT transaction_group_id INTO v_group FROM public.general_ledger WHERE idempotency_key = v_key
   ORDER BY created_at LIMIT 1;
  IF v_group IS NOT NULL THEN RETURN v_group; END IF;

  v_cycle_returns := round(coalesce(v_principal, 0) * coalesce(v_pct, 0) / 100);
  IF p_amount > v_cycle_returns THEN
    RAISE EXCEPTION 'Amount exceeds one cycle of Returns for this portfolio' USING ERRCODE = '22023'; END IF;

  v_recipient := v_investor;
  IF v_keep THEN
    SELECT CASE WHEN pa.is_managed_account THEN pa.agent_id ELSE v_investor END
      INTO v_recipient
      FROM public.proxy_agent_assignments pa
     WHERE pa.beneficiary_id = v_investor AND pa.is_active AND pa.approval_status = 'approved'
     ORDER BY pa.is_managed_account DESC, pa.created_at DESC
     LIMIT 1;
    v_recipient := coalesce(v_recipient, v_investor);
  END IF;

  v_group := public.create_ledger_transaction(
    entries => jsonb_build_array(
      jsonb_build_object(
        'user_id', v_investor, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', p_amount, 'category', 'roi_expense',
        'description', p_description_out, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', v_actor, 'currency', 'UGX'),
      CASE WHEN v_keep THEN jsonb_build_object(
        'user_id', v_recipient, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'roi_wallet_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'description', p_description_in, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', v_investor, 'currency', 'UGX')
      ELSE jsonb_build_object(
        'user_id', v_investor, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'roi_reinvestment',
        'description', p_description_in, 'reference_id', p_reference,
        'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
        'linked_party', CASE WHEN p_operation = 'compound' THEN v_actor ELSE v_investor END,
        'currency', 'UGX')
      END),
    idempotency_key => v_key);

  IF p_apply_portfolio THEN
    SELECT cycle_month INTO v_claim_month FROM public.portfolio_return_cycle_claims WHERE id = v_claim;
    IF p_operation = 'compound' THEN
      UPDATE public.investor_portfolios
         SET investment_amount = investment_amount + p_amount,
             -- A catch-up compound for an older cycle does not move the schedule past the current cycle.
             next_roi_date = CASE
               WHEN next_roi_date IS NULL OR v_claim_month >= date_trunc('month', next_roi_date)::date
                 THEN (coalesce(next_roi_date, p_cycle_date, (now() AT TIME ZONE 'Africa/Kampala')::date) + interval '1 month')::date
               ELSE next_roi_date END
       WHERE id = p_portfolio_id;
    ELSIF p_operation = 'split_reinvest' THEN
      UPDATE public.investor_portfolios SET investment_amount = investment_amount + p_amount WHERE id = p_portfolio_id;
    ELSE
      UPDATE public.investor_portfolios SET total_roi_earned = coalesce(total_roi_earned, 0) + p_amount WHERE id = p_portfolio_id;
    END IF;
  END IF;

  RETURN v_group;
END $function$;

-- Screens from this change: post AND change the portfolio, atomically.
CREATE FUNCTION public.post_portfolio_roi_ledger(
  p_operation text, p_portfolio_id uuid, p_amount numeric, p_reference text, p_description_out text,
  p_description_in text, p_cycle_date date, p_override_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN public._post_portfolio_roi_ledger_core(p_operation, p_portfolio_id, p_amount, p_reference, p_description_out,
                                               p_description_in, p_cycle_date, p_override_id, true);
END $function$;

-- The existing six-argument signature keeps its grants. Its only callers are the COO screens published before this
-- change, which change the portfolio themselves (compound: BEFORE posting, moving next_roi_date forward one month;
-- split: after). So this wrapper posts only, and for 'compound' the cycle is next_roi_date minus one month.
-- Updated screens call the eight-argument version; this wrapper only matters until they are published.
CREATE OR REPLACE FUNCTION public.post_portfolio_roi_ledger(p_operation text, p_portfolio_id uuid, p_amount numeric, p_reference text, p_description_out text, p_description_in text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_next date;
BEGIN
  SELECT next_roi_date INTO v_next FROM public.investor_portfolios WHERE id = p_portfolio_id;
  RETURN public._post_portfolio_roi_ledger_core(
    p_operation, p_portfolio_id, p_amount, p_reference, p_description_out, p_description_in,
    CASE WHEN p_operation = 'compound' AND v_next IS NOT NULL THEN (v_next - interval '1 month')::date ELSE v_next END,
    NULL::uuid, false);
END $function$;

-- ── CFO override (authorises; pays nothing) ───────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.authorise_return_cycle_override(p_portfolio_id uuid, p_cycle_date date, p_requester uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_id uuid;
  v_month date;
BEGIN
  IF v_actor IS NULL OR NOT public.is_cfo_approver(v_actor) THEN
    RAISE EXCEPTION 'Only the CFO approver can authorise an extra Return' USING ERRCODE = '42501'; END IF;
  IF p_portfolio_id IS NULL OR p_cycle_date IS NULL OR p_requester IS NULL THEN
    RAISE EXCEPTION 'Portfolio, cycle date and the person who will request the Return are required' USING ERRCODE = '22023'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 20 THEN
    RAISE EXCEPTION 'Give a reason of at least 20 characters' USING ERRCODE = '22023'; END IF;
  IF p_requester = v_actor THEN
    RAISE EXCEPTION 'The requester must be someone other than the CFO approver who authorises' USING ERRCODE = '42501'; END IF;
  IF NOT public._return_cycle_can_request(p_requester) THEN
    RAISE EXCEPTION 'The named requester is not staff allowed to request Partner Returns' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE id = p_portfolio_id) THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;

  v_month := date_trunc('month', p_cycle_date)::date;
  INSERT INTO public.portfolio_return_cycle_overrides (portfolio_id, cycle_month, reason, authorised_by, requester_id)
  VALUES (p_portfolio_id, v_month, btrim(p_reason), v_actor, p_requester)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
  VALUES (v_actor, 'return_cycle_override_authorised', 'portfolio_return_cycle_overrides', v_id::text,
          jsonb_build_object('portfolio_id', p_portfolio_id, 'cycle_month', v_month, 'requester_id', p_requester,
                             'expires_in_hours', 24, 'pays_nothing', true),
          btrim(p_reason));
  RETURN v_id;
END
$function$;

CREATE FUNCTION public.revoke_return_cycle_override(p_override_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.is_cfo_approver(v_actor) THEN
    RAISE EXCEPTION 'Only the CFO approver can revoke an override' USING ERRCODE = '42501'; END IF;
  UPDATE public.portfolio_return_cycle_overrides
     SET revoked_at = now(), revoked_by = v_actor, revoke_reason = left(btrim(coalesce(p_reason, '')), 1000)
   WHERE id = p_override_id AND consumed_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Override not found, already used or already revoked' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason)
  VALUES (v_actor, 'return_cycle_override_revoked', 'portfolio_return_cycle_overrides', p_override_id::text, p_reason);
END
$function$;

-- ── Grants (new functions are closed by default; set explicitly anyway) ──────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public._claim_return_cycle(uuid, date, text, text, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._return_cycle_claim_for_operation_row(public.pending_wallet_operations, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_return_cycle_for_operation(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_return_cycle_claim_on_status() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_return_cycle_ledger_key() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.authorise_return_cycle_override(uuid, date, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._post_portfolio_roi_ledger_core(text, uuid, numeric, text, text, text, date, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._return_cycle_can_request(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_return_cycle_override(uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.claim_return_cycle_for_operation(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorise_return_cycle_override(uuid, date, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_return_cycle_override(uuid, text) TO authenticated, service_role;
