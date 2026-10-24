-- 2026-10-24: Partner Return duplicate-payment prevention (CFO request, after the 24 Oct duplicate audit).
-- PREPARED FOR REVIEW. NOT APPLIED. This migration moves no money and changes no existing row: it adds two tables,
-- one nullable column (investor_portfolios.return_fields_edit_token), functions and triggers.
--
-- THE DEFECTS (24 Oct audit and the independent review)
--   * A Return cycle was identified by the exact text of next_roi_date at payment time; staff edits of that date
--     produced new keys, so the same month was paid again.
--   * The request check had no lock; correction_key skipped it unaudited; compounds and splits had no cycle check.
--   * Two approvals of the same request could both run, and the approval's wallet "recovery" could credit twice.
--   * A Return-coded credit could be paid from a request with no portfolio (supporter_platform_rewards).
--   * A split's parts were not capped against one cycle's Return.
--   * Screens open before a fix change principal / next date / total Returns themselves before posting.
--
-- WHAT THIS DOES
--   1. Cycle = CALENDAR MONTH of the scheduled Return date: (portfolio, cycle_month).
--   2. Reservation. Every Return reserves portfolio_return_cycle_claims BEFORE money moves, under a per-portfolio
--      advisory lock plus a partial unique index (one active claim per portfolio, month and sequence):
--        payout request (any insert into pending_wallet_operations) .... kind 'payout'
--        compound (post_portfolio_roi_ledger 'compound') .............. kind 'compound'
--        split (post_portfolio_roi_ledger 'split_*') + its cash request kind 'split' (the request joins the claim)
--      A reservation is refused without an override when: the month already has a Return (claim, or a credit under
--      the old roi-cycle-<portfolio>-<date> key); a Return without any cycle key was posted in that month or the
--      month after (historical compounds/splits/null-key credits, read only); another month's Return is < 20 days
--      away; the cycle is > 7 days ahead; the month is before 2026-08; or the amount exceeds one cycle's Return.
--   3. Cap. Each claim stores its cap (one cycle's Return at reservation, or an override's bounded maximum). Every
--      posting under a claim (cash, retained, reinvested) is checked so the claim's total never exceeds the cap -
--      by the posting functions and again by the ledger trigger.
--   4. Atomic approval. post_return_payout (service role) locks the request row, refuses it unless it is still
--      awaiting approval, posts under the claim key, marks it approved and moves next_roi_date, in ONE transaction,
--      and reports whether THIS call posted. approve-wallet-operation stops unless it did (no advance recovery or
--      other money step). The Return's wallet leg must name the Withdrawable bucket, so the approval never runs its
--      balance-snapshot wallet "recovery" for a Return (an unrelated withdrawal could mislead that check).
--      Lock order everywhere: request row, portfolio row, then the reservation lock (no deadlock with a compound).
--   5. Atomic compound/split. post_portfolio_roi_ledger posts and changes the portfolio in one transaction; a retry
--      with the same reference posts and changes nothing. The six-argument form (screens published before this
--      change) posts only.
--   6. Old screens cannot change principal or total Returns. A signed-in client UPDATE that changes
--      investment_amount or total_roi_earned is refused unless it also sets a new return_fields_edit_token; the
--      updated admin edit screens do, old screens and the Return screens never do. Server code is unaffected.
--   7. Ledger. A Return wallet credit (roi_wallet_credit, wallet, cash_in) must come from a verified source:
--        investor_portfolios ........ key return-cycle:<active claim>:<cash|retained>, within the claim's cap
--        supporter_roi_payments ..... an existing paid payment row for that rent request, supporter and amount, and
--                                     fewer credits than paid rows (rent-facilitation rewards)
--        partner_self_payout_cycles . key psm-payout-<cycle> for that cycle's partner and amount
--      and nothing else. A portfolio reinvestment needs return-cycle:<claim>:reinvest, except a rent-reward
--      auto-reinvestment (linked_party 'platform'), which needs a matching reinvested payment row.
--   8. Requests. A Return request (roi_payout or supporter_platform_rewards) must name its portfolio. A split's cash
--      request must fit within the split claim's cap. correction_key no longer bypasses anything.
--   9. CFO override (exceptional extra Return or amount above one cycle's Return). The CFO approver authorises it
--      for one portfolio and month, naming the one staff member who may use it (never the authoriser), with a
--      reason (>= 20 characters) and a maximum total (<= 2x one cycle's Return); single use, 24 hours, revocable,
--      audited (authorised / used / revoked). It is used only by that person's own signed-in session when the
--      request, compound or split is made, never at approval and never from service-role metadata.
--      AUTHORISING PAYS NOTHING.
--  10. Release. A payout claim is released only when its request is rejected/cancelled and nothing was posted, or
--      the posting was reversed by reverse-proxy-roi-approval (reversal then re-pay works). Split and compound claims
--      are never released automatically.
--
-- NOT COVERED: cfo-direct-credit refuses Return-coded credits in its edge function (not in this file); the
-- process-investment-interest edge function writes to a table that does not exist in production.
--
-- Replaces two live functions; the precondition pins their exact production bodies (2026-10-24).
-- TRANSACTION: run as ONE transaction (BEGIN; ... COMMIT;). The precondition changes nothing when it refuses.
-- DEPLOY ORDER (see docs/RETURN_CYCLE_GUARD_RUNBOOK.md): apply this; deploy approve-wallet-operation and
-- cfo-direct-credit immediately; then publish the frontend. Every step in between fails closed: the old approval's
-- Return postings are refused by the ledger; open screens' compound/split/principal edits are refused before they
-- change anything (no edit token); payout requests are reserved normally. Nothing is paid twice.
-- Rollback: supabase/rollbacks/20261024140000_return_cycle_guard.rollback.sql

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.portfolio_return_cycle_claims') IS NOT NULL
     OR to_regclass('public.portfolio_return_cycle_overrides') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'investor_portfolios' AND column_name = 'return_fields_edit_token')
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.enforce_roi_cycle_once()'::regprocedure)
          IS DISTINCT FROM '18ff622041302b9f25c9d174f8f819c5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = 'public.post_portfolio_roi_ledger(text,uuid,numeric,text,text,text)'::regprocedure)
          IS DISTINCT FROM '6313f826f8dc023c5b66a4c8bdcba6ff'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.create_ledger_transaction(jsonb,text,boolean)'::regprocedure)
          IS DISTINCT FROM '8e570ba579b151ac17788c0ee668a93b'
     OR to_regprocedure('public.is_cfo_approver(uuid)') IS NULL
     OR to_regprocedure('public._ledger_can_post_partner_returns(uuid)') IS NULL
     OR to_regprocedure('public.staff_mfa_ok()') IS NULL
     OR to_regclass('public.supporter_roi_payments') IS NULL
     OR to_regclass('public.partner_self_payout_cycles') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: the Return cycle objects already exist, or a function this replaces changed since 2026-10-24; nothing was changed';
  END IF;
END
$pre$;

-- ── Tables ────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.portfolio_return_cycle_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id      uuid NOT NULL REFERENCES public.investor_portfolios(id),
  cycle_month       date NOT NULL CHECK (cycle_month = date_trunc('month', cycle_month)::date),
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 20 AND length(reason) <= 1000),
  max_amount        numeric NOT NULL CHECK (max_amount > 0 AND max_amount = round(max_amount)),
  cycle_return_at_authorisation numeric NOT NULL,
  authorised_by     uuid NOT NULL,
  requester_id      uuid NOT NULL,      -- the only person who may use it; never the authoriser
  authorised_at     timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  consumed_at       timestamptz,
  consumed_claim_id uuid,
  revoked_at        timestamptz,
  revoked_by        uuid,
  revoke_reason     text,
  CHECK (requester_id <> authorised_by),
  CHECK (max_amount <= 2 * cycle_return_at_authorisation)
);
COMMENT ON TABLE public.portfolio_return_cycle_overrides IS
  'Single-use CFO authorisation for an exceptional extra Return in a portfolio cycle, bounded by max_amount. Authorising pays nothing.';

CREATE TABLE public.portfolio_return_cycle_claims (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id         uuid NOT NULL REFERENCES public.investor_portfolios(id),
  cycle_month          date NOT NULL CHECK (cycle_month = date_trunc('month', cycle_month)::date),
  cycle_date           date NOT NULL,
  claim_seq            integer NOT NULL DEFAULT 0 CHECK (claim_seq >= 0),
  kind                 text NOT NULL CHECK (kind IN ('payout', 'split', 'compound')),
  cycle_return_cap     numeric NOT NULL CHECK (cycle_return_cap >= 0),
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
  'One active row per portfolio Return cycle (calendar month). Ledger Return legs must carry return-cycle:<id>:<leg>; their total never exceeds cycle_return_cap.';

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

-- Explicit-edit token: a signed-in client may change principal / total Returns only in an UPDATE that also sets a new
-- token (the updated admin edit screens). Nullable, no default: no existing row changes.
ALTER TABLE public.investor_portfolios ADD COLUMN return_fields_edit_token uuid;
COMMENT ON COLUMN public.investor_portfolios.return_fields_edit_token IS
  'Set to a new random value by an explicit staff edit of investment_amount / total_roi_earned. Return postings change those fields server-side.';

-- ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────

-- Staff who may request a Partner Return (COO page users).
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

-- Total already posted (cash + retained + reinvested) under a claim.
CREATE FUNCTION public._return_cycle_posted_total(p_claim uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(sum(g.amount), 0) FROM public.general_ledger g
   WHERE g.direction = 'cash_in' AND g.category IN ('roi_wallet_credit', 'roi_reinvestment')
     AND g.idempotency_key IN ('return-cycle:' || p_claim::text || ':cash',
                               'return-cycle:' || p_claim::text || ':retained',
                               'return-cycle:' || p_claim::text || ':reinvest')
$function$;

-- ── Core: reserve a cycle ─────────────────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public._claim_return_cycle(
  p_portfolio_id uuid, p_cycle_date date, p_kind text, p_source text, p_reference text,
  p_pending_operation_id uuid, p_override_id uuid, p_actor uuid, p_amount numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_early_days    CONSTANT integer := 7;
  c_min_spacing   CONSTANT integer := 20;
  c_reliable_from CONSTANT date := DATE '2026-08-01';
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_pf      record;
  v_cycle   date;
  v_month   date;
  v_claim   uuid;
  v_ovr     record;
  v_seq     integer := 0;
  v_cap     numeric;
  v_reasons text[] := ARRAY[]::text[];
  v_legacy  constant text := 'roi-cycle-' || p_portfolio_id::text || '-';
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('payout', 'split', 'compound') THEN
    RAISE EXCEPTION 'Unknown Return cycle kind' USING ERRCODE = '22023'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A Return amount is required' USING ERRCODE = '22023'; END IF;

  -- LOCK ORDER (everywhere): the portfolio row first, then the reservation lock. A compound takes them in this order
  -- too; taking them the other way round deadlocks with it (the claim row's foreign key also locks this row).
  SELECT id, portfolio_code, next_roi_date, investment_amount, roi_percentage INTO v_pf
    FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;

  v_cycle := coalesce(p_cycle_date, v_pf.next_roi_date, v_today);
  v_month := date_trunc('month', v_cycle)::date;
  v_cap := round(coalesce(v_pf.investment_amount, 0) * coalesce(v_pf.roi_percentage, 0) / 100);

  -- Serialise every Return reservation for this portfolio; the unique index is the second lock.
  PERFORM pg_advisory_xact_lock(hashtext('return-cycle'), hashtext(p_portfolio_id::text));

  -- A retry of the same request (same queued payout, or same reference) gets its own claim back.
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

  -- Credits under the previous key scheme count as paid for their month unless the payout was reversed.
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

  -- Returns posted before this guard WITHOUT any cycle key (compounds, split parts, null-key credits) cannot be tied
  -- to a cycle exactly. Payments are made up to about a month late, so one posted in month M or M+1 blocks month M
  -- (errs toward refusing; resolved by an override). Historical records are only read.
  IF EXISTS (SELECT 1 FROM public.general_ledger g
              WHERE g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id AND g.direction = 'cash_in'
                AND ((g.category = 'roi_wallet_credit' AND coalesce(g.ledger_scope, 'wallet') = 'wallet')
                     OR (g.category = 'roi_reinvestment' AND coalesce(g.linked_party, '') <> 'platform'))
                AND (g.idempotency_key IS NULL OR g.idempotency_key LIKE 'portfolio-roi-ledger:%')
                AND date_trunc('month', (g.transaction_date AT TIME ZONE 'Africa/Kampala'))::date
                    IN (v_month, (v_month + interval '1 month')::date)) THEN
    v_reasons := array_append(v_reasons, 'unkeyed_return_this_or_next_month');
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

  IF v_cycle > v_today + c_early_days THEN v_reasons := array_append(v_reasons, 'not_yet_due'); END IF;
  IF v_month < c_reliable_from THEN v_reasons := array_append(v_reasons, 'before_reliable_history'); END IF;
  IF p_amount > v_cap THEN v_reasons := array_append(v_reasons, 'amount_above_cycle_return'); END IF;

  IF cardinality(v_reasons) > 0 THEN
    IF p_override_id IS NULL THEN
      RAISE EXCEPTION 'Duplicate Return blocked: portfolio % (%): % for the % cycle.',
          coalesce(v_pf.portfolio_code, p_portfolio_id::text), array_to_string(v_reasons, ', '),
          CASE WHEN 'already_claimed' = ANY (v_reasons) OR 'already_paid' = ANY (v_reasons)
               THEN 'a Return already exists' ELSE 'this Return cannot be paid without an override' END,
          to_char(v_month, 'FMMonth YYYY')
        -- 23505 = the cycle already has a Return; 23514 = refused for another reason.
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
    -- Only a real signed-in session of the named requester can use it (never service-role metadata).
    IF auth.uid() IS NULL OR p_actor IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'An override can only be used from the named requester''s own signed-in session' USING ERRCODE = '42501'; END IF;
    IF v_ovr.authorised_by = p_actor THEN
      RAISE EXCEPTION 'The person who authorised the override cannot also request the Return' USING ERRCODE = '42501'; END IF;
    IF v_ovr.requester_id <> p_actor OR NOT public._return_cycle_can_request(p_actor) THEN
      RAISE EXCEPTION 'This override was authorised for another requester' USING ERRCODE = '42501'; END IF;
    IF p_amount > v_ovr.max_amount THEN
      RAISE EXCEPTION 'Amount is above the override''s authorised maximum' USING ERRCODE = '42501'; END IF;

    SELECT coalesce(max(claim_seq), -1) + 1 INTO v_seq FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_portfolio_id AND cycle_month = v_month AND status = 'active';
    v_cap := v_ovr.max_amount;
  ELSIF p_override_id IS NOT NULL THEN
    RAISE EXCEPTION 'No override is needed: this Return cycle is unpaid. The override was not used.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.portfolio_return_cycle_claims
    (portfolio_id, cycle_month, cycle_date, claim_seq, kind, cycle_return_cap, source, reference, pending_operation_id,
     override_id, claimed_by)
  VALUES (p_portfolio_id, v_month, v_cycle, v_seq, p_kind, v_cap, p_source, p_reference, p_pending_operation_id,
          p_override_id, p_actor)
  RETURNING id INTO v_claim;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.portfolio_return_cycle_overrides SET consumed_at = now(), consumed_claim_id = v_claim WHERE id = p_override_id;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
    VALUES (p_actor, 'return_cycle_override_used', 'portfolio_return_cycle_claims', v_claim::text,
            jsonb_build_object('portfolio_id', p_portfolio_id, 'cycle_month', v_month, 'override_id', p_override_id,
                               'authorised_by', v_ovr.authorised_by, 'blocked_reasons', v_reasons, 'source', p_source,
                               'amount', p_amount, 'max_amount', v_ovr.max_amount),
            v_ovr.reason);
  END IF;

  RETURN v_claim;
END
$function$;

-- Turns a queued payout request into a claim (or joins its split). Used by the request trigger and by approval.
-- p_at_approval: the request was queued before this migration and is only now being reserved.
CREATE FUNCTION public._return_cycle_claim_for_operation_row(p_op public.pending_wallet_operations, p_at_approval boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claim record;
  v_cycle date;
  v_override uuid;
  v_actor uuid;
BEGIN
  IF coalesce(p_op.operation_type, '') LIKE 'roi_split\_%' THEN
    -- The cash portion of a split joins the claim its split posting made (same reference, same portfolio), and must
    -- fit within that claim's cap together with what was already posted.
    SELECT * INTO v_claim FROM public.portfolio_return_cycle_claims
     WHERE portfolio_id = p_op.source_id AND status = 'active' AND kind = 'split' AND reference = p_op.reference_id
       AND (pending_operation_id IS NULL OR pending_operation_id = p_op.id)
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Split cash portion % has no matching split Return for this portfolio', p_op.reference_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF public._return_cycle_posted_total(v_claim.id) + coalesce(p_op.amount, 0) > v_claim.cycle_return_cap THEN
      RAISE EXCEPTION 'Split total would exceed this cycle''s Return (% already posted, cap %)',
        public._return_cycle_posted_total(v_claim.id), v_claim.cycle_return_cap USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public.portfolio_return_cycle_claims SET pending_operation_id = p_op.id WHERE id = v_claim.id;
    RETURN v_claim.id;
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
  IF v_override IS NOT NULL THEN
    -- Overrides: the signed-in session only; never at approval; metadata is never trusted for identity.
    IF p_at_approval OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'An override is used only from the named requester''s own signed-in session when the Return is requested'
        USING ERRCODE = '42501';
    END IF;
    v_actor := auth.uid();
  ELSE
    v_actor := coalesce(auth.uid(), nullif(p_op.metadata ->> 'initiated_by', '')::uuid);
  END IF;

  -- A request queued before this guard that does not name its cycle would otherwise be read against next_roi_date as
  -- it is NOW. If the portfolio received any Return after the request was made, refuse it (the 7-8 July pattern).
  IF p_at_approval AND v_cycle IS NULL AND (
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
                                    p_op.reference_id, p_op.id, v_override, v_actor, p_op.amount);
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
  -- A Partner Return request must name its portfolio. Rent-facilitation rewards are credited by process-supporter-roi
  -- directly against their payment rows, never through this queue.
  IF NEW.category IN ('roi_payout', 'supporter_platform_rewards')
     AND (NEW.source_table IS DISTINCT FROM 'investor_portfolios' OR NEW.source_id IS NULL) THEN
    RAISE EXCEPTION 'A Partner Return payout request must name its portfolio' USING ERRCODE = '23514';
  END IF;
  IF coalesce(NEW.category, '') NOT IN ('roi_payout', 'supporter_platform_rewards') THEN
    RETURN NEW;
  END IF;

  -- Lock order: portfolio row, then the reservation lock (see _claim_return_cycle).
  PERFORM 1 FROM public.investor_portfolios WHERE id = NEW.source_id FOR UPDATE;
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

-- Approval, read side (service role only): the reservation this request holds (created now for a request queued
-- before this migration) and its posting key. Used to decide early; post_return_payout re-checks everything.
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
  IF coalesce(v_op.category, '') NOT IN ('roi_payout', 'supporter_platform_rewards') THEN
    RETURN jsonb_build_object('applies', false);
  END IF;
  IF v_op.source_table IS DISTINCT FROM 'investor_portfolios' OR v_op.source_id IS NULL THEN
    RAISE EXCEPTION 'This Return request names no portfolio; it cannot be paid' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_claim FROM public.portfolio_return_cycle_claims
   WHERE pending_operation_id = p_operation_id AND status = 'active'
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM 1 FROM public.investor_portfolios WHERE id = v_op.source_id FOR UPDATE;   -- lock order: row, then reservation
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
    'cycle_return_cap', v_claim.cycle_return_cap,
    'ledger_key', v_key,
    'already_posted', EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_key),
    'advance_next_roi_date', v_current IS NULL OR v_claim.cycle_month >= date_trunc('month', v_current)::date);
END
$function$;

-- Approval, write side (service role only). ONE transaction, holding a row lock on the request:
--   refuse unless the request is still awaiting approval; take/verify its reservation; refuse if the key is already
--   used; check the claim's cap; post the entries under the key; mark the request approved; move next_roi_date
--   (not for a catch-up). Returns inserted=true only to the call that posted. A concurrent second approval waits on
--   the row lock and then sees 'approved' -> inserted=false, so the caller performs no further money step.
CREATE FUNCTION public.post_return_payout(
  p_operation_id uuid, p_entries jsonb, p_ledger_key text, p_amount numeric, p_reviewed_by uuid,
  p_payment_method text DEFAULT NULL, p_payment_reference text DEFAULT NULL)
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
  v_group uuid;
  v_wallet_total numeric;
  v_current date;
  v_advanced boolean := false;
BEGIN
  SELECT * INTO v_op FROM public.pending_wallet_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Operation not found' USING ERRCODE = 'P0002'; END IF;
  IF coalesce(v_op.category, '') NOT IN ('roi_payout', 'supporter_platform_rewards')
     OR v_op.source_table IS DISTINCT FROM 'investor_portfolios' OR v_op.source_id IS NULL THEN
    RAISE EXCEPTION 'Not a portfolio Return request' USING ERRCODE = '22023';
  END IF;
  IF v_op.status NOT IN ('pending', 'coo_approved') THEN
    RETURN jsonb_build_object('inserted', false, 'reason', 'not_awaiting_approval', 'status', v_op.status);
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a positive whole number' USING ERRCODE = '22023';
  END IF;

  -- Lock order: the request row (above), the portfolio row, then the reservation lock - the same order as a compound.
  PERFORM 1 FROM public.investor_portfolios WHERE id = v_op.source_id FOR UPDATE;

  SELECT * INTO v_claim FROM public.portfolio_return_cycle_claims
   WHERE pending_operation_id = p_operation_id AND status = 'active' ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtext('return-cycle'), hashtext(v_op.source_id::text));
    v_claim_id := public._return_cycle_claim_for_operation_row(v_op, true);
    SELECT * INTO v_claim FROM public.portfolio_return_cycle_claims WHERE id = v_claim_id;
  END IF;
  IF v_claim.portfolio_id <> v_op.source_id THEN
    RAISE EXCEPTION 'Return request no longer matches the portfolio it reserved' USING ERRCODE = '42501';
  END IF;
  v_key := 'return-cycle:' || v_claim.id::text || ':cash';
  IF p_ledger_key IS DISTINCT FROM v_key THEN
    RAISE EXCEPTION 'Posting key does not match this request''s reservation' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.general_ledger WHERE idempotency_key = v_key) THEN
    RETURN jsonb_build_object('inserted', false, 'reason', 'already_posted');
  END IF;

  -- The entries must credit exactly p_amount to one wallet, as a Return of this portfolio.
  IF jsonb_typeof(p_entries) <> 'array' THEN RAISE EXCEPTION 'entries must be an array' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(sum((e ->> 'amount')::numeric), 0) INTO v_wallet_total
    FROM jsonb_array_elements(p_entries) e
   WHERE coalesce(e ->> 'ledger_scope', 'wallet') = 'wallet' AND e ->> 'direction' = 'cash_in';
  IF v_wallet_total <> p_amount
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_entries) e
                 WHERE coalesce(e ->> 'ledger_scope', 'wallet') = 'wallet' AND e ->> 'direction' = 'cash_in'
                   AND (e ->> 'category' IS DISTINCT FROM 'roi_wallet_credit'
                        OR e ->> 'source_table' IS DISTINCT FROM 'investor_portfolios'
                        OR (e ->> 'source_id')::uuid IS DISTINCT FROM v_op.source_id
                        -- Explicit bucket: the credit lands in the recipient's Withdrawable by the ledger's own rule,
                        -- so no balance-snapshot check or wallet "recovery" is ever needed for a Return.
                        OR e ->> 'wallet_bucket' IS DISTINCT FROM 'withdrawable'
                        OR e ->> 'recipient_type' IS DISTINCT FROM 'user')) THEN
    RAISE EXCEPTION 'Return entries do not match the request amount, portfolio and Withdrawable bucket' USING ERRCODE = '22023';
  END IF;

  IF public._return_cycle_posted_total(v_claim.id) + p_amount > v_claim.cycle_return_cap THEN
    RAISE EXCEPTION 'Amount would exceed this cycle''s Return (% already posted, cap %). An exceptional amount needs a CFO-authorised override.',
      public._return_cycle_posted_total(v_claim.id), v_claim.cycle_return_cap USING ERRCODE = '23514';
  END IF;

  v_group := public.create_ledger_transaction(entries => p_entries, idempotency_key => v_key);

  UPDATE public.pending_wallet_operations
     SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now(), updated_at = now(),
         payment_method = p_payment_method, payment_reference = p_payment_reference, amount = p_amount
   WHERE id = p_operation_id;

  SELECT next_roi_date INTO v_current FROM public.investor_portfolios WHERE id = v_op.source_id FOR UPDATE;
  IF v_current IS NULL OR v_claim.cycle_month >= date_trunc('month', v_current)::date THEN
    UPDATE public.investor_portfolios
       SET next_roi_date = (coalesce(next_roi_date, created_at::date) + interval '1 month')::date
     WHERE id = v_op.source_id;
    v_advanced := true;
  END IF;

  RETURN jsonb_build_object('inserted', true, 'transaction_group_id', v_group, 'claim_id', v_claim.id,
                            'next_roi_date_advanced', v_advanced);
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

-- ── Ledger: verified source for every Return credit, cap for every portfolio Return ──────────────────────────────

CREATE FUNCTION public.enforce_return_cycle_ledger_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m text[];
  c record;
  v_is_wallet_return boolean;
  v_is_reinvest boolean;
BEGIN
  IF NEW.direction IS DISTINCT FROM 'cash_in' THEN RETURN NEW; END IF;
  -- create_ledger_transaction treats a missing scope as 'wallet'; so does this check.
  v_is_wallet_return := NEW.category = 'roi_wallet_credit' AND coalesce(NEW.ledger_scope, 'wallet') = 'wallet';
  v_is_reinvest := NEW.category = 'roi_reinvestment' AND NEW.source_table IS NOT DISTINCT FROM 'investor_portfolios';
  IF NOT (v_is_wallet_return OR v_is_reinvest) THEN RETURN NEW; END IF;

  -- Rent-facilitation reward (process-supporter-roi): a paid payment row for this rent request, supporter and amount,
  -- and fewer wallet credits for that rent request than paid rows.
  IF v_is_wallet_return AND NEW.source_table = 'supporter_roi_payments' THEN
    IF NOT EXISTS (SELECT 1 FROM public.supporter_roi_payments s
                    WHERE s.rent_request_id = NEW.source_id AND s.supporter_id = NEW.user_id
                      AND s.roi_amount = NEW.amount AND s.status = 'paid')
       OR (SELECT count(*) FROM public.general_ledger g
            WHERE g.category = 'roi_wallet_credit' AND g.direction = 'cash_in'
              AND g.source_table = 'supporter_roi_payments' AND g.source_id = NEW.source_id)
          >= (SELECT count(*) FROM public.supporter_roi_payments s
               WHERE s.rent_request_id = NEW.source_id AND s.status = 'paid') THEN
      RAISE EXCEPTION 'Rent-facilitation reward has no unpaid payment record; it was not posted.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Self-managed partner cycle (pay_partner_self_cycles): its own cycle row and key.
  IF v_is_wallet_return AND NEW.source_table = 'partner_self_payout_cycles' THEN
    IF NEW.idempotency_key IS DISTINCT FROM 'psm-payout-' || NEW.source_id::text
       OR NOT EXISTS (SELECT 1 FROM public.partner_self_payout_cycles p
                       WHERE p.id = NEW.source_id AND p.partner_id = NEW.user_id AND p.total_amount = NEW.amount) THEN
      RAISE EXCEPTION 'Self-managed partner Return does not match its cycle; it was not posted.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Rent-reward auto-reinvestment (process-supporter-roi, linked_party 'platform'): a reinvested payment row.
  IF v_is_reinvest AND coalesce(NEW.linked_party, '') = 'platform' THEN
    IF NOT EXISTS (SELECT 1 FROM public.supporter_roi_payments s
                    WHERE s.supporter_id = NEW.user_id AND s.roi_amount = NEW.amount AND s.status = 'reinvested')
       OR (SELECT count(*) FROM public.general_ledger g
            WHERE g.category = 'roi_reinvestment' AND g.direction = 'cash_in' AND g.linked_party = 'platform'
              AND g.user_id = NEW.user_id AND g.amount = NEW.amount)
          >= (SELECT count(*) FROM public.supporter_roi_payments s
               WHERE s.supporter_id = NEW.user_id AND s.roi_amount = NEW.amount AND s.status = 'reinvested') THEN
      RAISE EXCEPTION 'Rent-reward reinvestment has no reinvested payment record; it was not posted.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_table IS DISTINCT FROM 'investor_portfolios' OR NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Return credit has no verified source (portfolio cycle, rent-reward payment or self-managed cycle); it was not posted.'
      USING ERRCODE = 'check_violation';
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
  IF public._return_cycle_posted_total(c.id) + NEW.amount > c.cycle_return_cap THEN
    RAISE EXCEPTION 'Return for portfolio % would exceed its cycle''s Return (cap %); it was not posted.', NEW.source_id, c.cycle_return_cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_enforce_return_cycle_ledger_key
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enforce_return_cycle_ledger_key();

-- ── Principal / total Returns: no client-side change without an explicit edit token ──────────────────────────────

-- SECURITY INVOKER on purpose (like enforce_investor_portfolio_field_immutability): current_user is then the role the
-- UPDATE runs as - 'authenticated' for a signed-in client request through the API, the function owner inside a
-- SECURITY DEFINER function such as post_portfolio_roi_ledger, service_role for edge functions.
CREATE FUNCTION public.guard_portfolio_return_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;
  IF (NEW.investment_amount IS DISTINCT FROM OLD.investment_amount
      OR NEW.total_roi_earned IS DISTINCT FROM OLD.total_roi_earned)
     AND NEW.return_fields_edit_token IS NOT DISTINCT FROM OLD.return_fields_edit_token THEN
    RAISE EXCEPTION 'Principal and Returns change only through a Return posting or an explicit portfolio edit. Reload the page and try again.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_guard_portfolio_return_fields
  BEFORE UPDATE ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.guard_portfolio_return_fields();

-- ── Compound and split Returns ────────────────────────────────────────────────────────────────────────────────────

-- Production body (2026-10-24) plus: the reservation; a key naming the claim; the claim cap; and, when
-- p_apply_portfolio, the portfolio change in the SAME transaction (compound: principal + one month on next_roi_date;
-- split_reinvest: principal; split_keep_returns: total_roi_earned). A retry of the same reference returns the
-- existing posting and changes nothing.
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
  v_investor uuid; v_principal numeric; v_pct numeric; v_next date;
  v_recipient uuid; v_keep boolean; v_claim uuid; v_key text; v_group uuid; v_claim_row record;
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
                                        'post_portfolio_roi_ledger', p_reference, NULL, p_override_id, v_actor, p_amount);
  v_keep := p_operation = 'split_keep_returns';
  v_key := 'return-cycle:' || v_claim::text || ':' || CASE WHEN v_keep THEN 'retained' ELSE 'reinvest' END;

  -- Retry of a posting that already went through: return it, post nothing, change nothing.
  SELECT transaction_group_id INTO v_group FROM public.general_ledger WHERE idempotency_key = v_key
   ORDER BY created_at LIMIT 1;
  IF v_group IS NOT NULL THEN RETURN v_group; END IF;

  SELECT * INTO v_claim_row FROM public.portfolio_return_cycle_claims WHERE id = v_claim;
  IF public._return_cycle_posted_total(v_claim) + p_amount > v_claim_row.cycle_return_cap THEN
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
    IF p_operation = 'compound' THEN
      UPDATE public.investor_portfolios
         SET investment_amount = investment_amount + p_amount,
             -- A catch-up compound for an older cycle does not move the schedule past the current cycle.
             next_roi_date = CASE
               WHEN next_roi_date IS NULL OR v_claim_row.cycle_month >= date_trunc('month', next_roi_date)::date
                 THEN (coalesce(next_roi_date, v_claim_row.cycle_date) + interval '1 month')::date
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

-- The existing six-argument signature keeps its grants. Its only callers are screens published before this change.
-- Those screens try to change the portfolio themselves first; trg_guard_portfolio_return_fields now refuses that
-- write, so they stop before calling this. If one gets here anyway it posts only (for 'compound' the cycle is
-- next_roi_date minus one month, matching those screens).
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

CREATE FUNCTION public.authorise_return_cycle_override(
  p_portfolio_id uuid, p_cycle_date date, p_requester uuid, p_max_amount numeric, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_id uuid;
  v_month date;
  v_cycle_return numeric;
BEGIN
  IF v_actor IS NULL OR NOT public.is_cfo_approver(v_actor) THEN
    RAISE EXCEPTION 'Only the CFO approver can authorise an extra Return' USING ERRCODE = '42501'; END IF;
  IF p_portfolio_id IS NULL OR p_cycle_date IS NULL OR p_requester IS NULL OR p_max_amount IS NULL THEN
    RAISE EXCEPTION 'Portfolio, cycle date, requester and maximum amount are required' USING ERRCODE = '22023'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 20 THEN
    RAISE EXCEPTION 'Give a reason of at least 20 characters' USING ERRCODE = '22023'; END IF;
  IF p_requester = v_actor THEN
    RAISE EXCEPTION 'The requester must be someone other than the CFO approver who authorises' USING ERRCODE = '42501'; END IF;
  IF NOT public._return_cycle_can_request(p_requester) THEN
    RAISE EXCEPTION 'The named requester is not staff allowed to request Partner Returns' USING ERRCODE = '42501'; END IF;
  SELECT round(investment_amount * roi_percentage / 100) INTO v_cycle_return
    FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'P0002'; END IF;
  IF p_max_amount <= 0 OR p_max_amount <> round(p_max_amount) OR p_max_amount > 2 * v_cycle_return THEN
    RAISE EXCEPTION 'Maximum amount must be a whole number above 0 and at most twice one cycle''s Return (%)', 2 * v_cycle_return
      USING ERRCODE = '22023'; END IF;

  v_month := date_trunc('month', p_cycle_date)::date;
  INSERT INTO public.portfolio_return_cycle_overrides
    (portfolio_id, cycle_month, reason, max_amount, cycle_return_at_authorisation, authorised_by, requester_id)
  VALUES (p_portfolio_id, v_month, btrim(p_reason), p_max_amount, v_cycle_return, v_actor, p_requester)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata, reason)
  VALUES (v_actor, 'return_cycle_override_authorised', 'portfolio_return_cycle_overrides', v_id::text,
          jsonb_build_object('portfolio_id', p_portfolio_id, 'cycle_month', v_month, 'requester_id', p_requester,
                             'max_amount', p_max_amount, 'cycle_return', v_cycle_return,
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

REVOKE EXECUTE ON FUNCTION public._return_cycle_can_request(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._return_cycle_posted_total(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._claim_return_cycle(uuid, date, text, text, text, uuid, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._return_cycle_claim_for_operation_row(public.pending_wallet_operations, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_return_cycle_for_operation(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.post_return_payout(uuid, jsonb, text, numeric, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_return_cycle_claim_on_status() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_return_cycle_ledger_key() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_portfolio_return_fields() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._post_portfolio_roi_ledger_core(text, uuid, numeric, text, text, text, date, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.authorise_return_cycle_override(uuid, date, uuid, numeric, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_return_cycle_override(uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.claim_return_cycle_for_operation(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_return_payout(uuid, jsonb, text, numeric, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_portfolio_roi_ledger(text, uuid, numeric, text, text, text, date, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorise_return_cycle_override(uuid, date, uuid, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_return_cycle_override(uuid, text) TO authenticated, service_role;
