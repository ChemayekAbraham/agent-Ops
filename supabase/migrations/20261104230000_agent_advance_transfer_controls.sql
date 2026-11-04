-- 2026-11-04: Agent Advances - permanent controls (CFO). Production apply needs explicit CFO approval.
-- Root causes (production read-only review 2026-11-04):
--   * a balance was "moved" by paying out a new advance (wallet credit) and then cancelling the old one with mode write_off,
--     which posted nothing: the receivable stayed on the old advance and appeared again on the new one;
--   * the extra wallet credit was then pulled back with a finops "error correction" (DR L1 / CR E3), unlinked to the payout,
--     sometimes for more than was credited (+108, +22,913), and sometimes not at all (1,500,000; 397,613);
--   * nothing stopped the same payout being made twice (two 1,500,000 credits to one agent within 15 hours);
--   * cancel_agent_advance accepted any reason: no destination, no approval, no ledger entry.
-- What this migration does (accounting and controls only - no wallet balance changes, no payments, no historical correction):
--   1. cfo_transfer_agent_advance: accounting-only transfer to a replacement, existing, ROI-recovered or partnership advance.
--      One ledger group (adv_transfer:<id>): DR destination A10 / CR source A10, A11, A20 (what the books carry); any part the
--      books never carried (legacy) is credited to E3. No wallet leg. Idempotency key required; replays return the first result.
--   2. Duplicate receivables cannot arise from a transfer: the source is credited by exactly what moves, the source closes
--      (mode 'transfer') when nothing is left, and the destination is marked funding_type 'transfer'.
--   3/4. A payout (cfo_create_advance, disburse_agent_advance_request, apply_advance_topup) equal to an existing advance's
--      balance, or to the principal of an advance the agent got in the last 7 days, is refused as a likely transfer unless the
--      reason says [NEW MONEY]. Genuine payouts are unchanged.
--   5. Duplicate submissions: the same create / disburse / top-up / manual payment twice inside two minutes is refused.
--   6. Wallet reversals: reserve_wallet_reversal / settle_wallet_reversal (used by finops-wallet-move): a reversal is linked to
--      the credit it reverses and can never exceed it; reversing an advance payout credits A10 and reduces the advance instead of
--      crediting E3.
--   7. cancel_agent_advance: an outstanding balance needs a Transfer, recoup, or an approved write-off
--      (request_agent_advance_write_off + decide_agent_advance_write_off by a different CFO / CEO); the write-off is posted
--      DR X4 / CR A10, A11, A20 (key adv_writeoff:<id>) and kept out of the CFO "Money paid" reports.
--   8. get_agent_advance_exceptions / run_agent_advance_reconciliation (daily, cron if available): closed advances with a book
--      balance, undocumented cancellations, payouts returned by unlinked corrections, reversals above the original, duplicate
--      payouts, live advances whose books differ from the record.
-- Repayment, deduction and commission rules are unchanged. Categories used are all already allowlisted and mapped.
-- Rollback: supabase/rollbacks/20261104230000_agent_advance_transfer_controls.rollback.sql. Tests: src/test/agentAdvanceTransferControls.test.ts.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF
        (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cancel_agent_advance(uuid,boolean,text)')) IS DISTINCT FROM '68e98c8d9dcd62502b282be426f3cced'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_create_advance(uuid,numeric,integer,numeric,text,text,boolean,text)')) IS DISTINCT FROM '0326c099ba6448dc47b1cfa73a1337dc'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.disburse_agent_advance_request(uuid,numeric,integer,numeric,text,text,text,text,numeric)')) IS DISTINCT FROM '9b660f07ecba3741d8616c3005dfa70a'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.apply_advance_topup(uuid,numeric,integer,uuid,text,boolean)')) IS DISTINCT FROM '3c2cbb35c83e349a9e638c6cb5f2e02b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.cfo_record_advance_payment(uuid,numeric,text,text,text)')) IS DISTINCT FROM 'd74a4d69afdb91681e2b6f00e79fb8c5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_paid_by_category_totals(date,date)')) IS DISTINCT FROM '42525180ea3dbc9ea67d0dce4df75c33'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_cfo_paid_by_category_page(date,date,text,text,integer,integer)')) IS DISTINCT FROM 'bec8062bea85a6cf4453dbd29b94cc5c' THEN
    RAISE EXCEPTION 'agent advance controls: production definitions differ from 2026-11-04 - re-read before applying';
  END IF;
  IF to_regclass('public.agent_advance_transfers') IS NOT NULL THEN RAISE EXCEPTION 'agent advance controls: already applied'; END IF;
  IF NOT (public.ledger_category_allowlist() @> ARRAY['agent_advance_receivable_opening', 'agent_access_fee_receivable_opening',
      'agent_advance_registration_fee_collected_external', 'receivable_restatement_equity', 'platform_loss_writeoff', 'agent_advance_written_off',
      'agent_advance_access_fee_written_off', 'agent_advance_registration_fee_written_off', 'agent_advance_reversed']) THEN
    RAISE EXCEPTION 'agent advance controls: a category is not allowlisted';
  END IF;
END $pre$;

-- ---------------------------------------------------------------- 1. schema
ALTER TABLE public.agent_advances DROP CONSTRAINT agent_advances_cancellation_mode_check;
ALTER TABLE public.agent_advances ADD CONSTRAINT agent_advances_cancellation_mode_check
  CHECK (cancellation_mode IS NULL OR cancellation_mode IN ('write_off', 'recoup_from_wallet', 'transfer', 'write_off_approved', 'payout_reversed'));
COMMENT ON COLUMN public.agent_advances.cancellation_mode IS
  'write_off: legacy (before 2026-11-04 controls, no ledger posting); recoup_from_wallet: balance kept; transfer: balance moved to '
  'another advance by cfo_transfer_agent_advance (agent_advance_transfers); write_off_approved: approved write-off posted to X4; '
  'payout_reversed: the payout was returned through a linked wallet reversal.';
ALTER TABLE public.agent_advances
  ADD COLUMN funding_type text NOT NULL DEFAULT 'disbursement' CHECK (funding_type IN ('disbursement', 'transfer')),
  ADD COLUMN transferred_from_advance_id uuid,
  ADD COLUMN transfer_id uuid;
COMMENT ON COLUMN public.agent_advances.funding_type IS
  'disbursement: money was paid to the agent (wallet credit). transfer: created by moving another advance''s balance - no money moved.';

CREATE TABLE public.agent_advance_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  from_advance_id uuid NOT NULL REFERENCES public.agent_advances(id),
  to_advance_id uuid NOT NULL REFERENCES public.agent_advances(id),
  destination_type text NOT NULL CHECK (destination_type IN ('new_advance', 'existing_advance')),
  from_agent_id uuid NOT NULL,
  to_agent_id uuid NOT NULL,
  cross_account_reason text,
  amount numeric NOT NULL CHECK (amount > 0),
  moved_a10 numeric NOT NULL DEFAULT 0,
  moved_a11 numeric NOT NULL DEFAULT 0,
  moved_a20 numeric NOT NULL DEFAULT 0,
  not_previously_booked numeric NOT NULL DEFAULT 0,
  from_outstanding_before numeric NOT NULL,
  from_outstanding_after numeric NOT NULL,
  source_closed boolean NOT NULL,
  ledger_group_id uuid,
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_advance_id <> to_advance_id),
  CHECK (from_agent_id = to_agent_id OR length(btrim(COALESCE(cross_account_reason, ''))) >= 15)
);
COMMENT ON TABLE public.agent_advance_transfers IS
  'Accounting-only transfer of an advance balance to a replacement / existing / ROI-recovered / partnership advance (no wallet '
  'movement). One ledger group per transfer (key adv_transfer:<id>): DR destination A10 / CR source A10, A11, A20; amounts the '
  'books never carried (legacy) are credited to E3. Written only by cfo_transfer_agent_advance.';

CREATE TABLE public.agent_advance_write_off_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.agent_advances(id),
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 20),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'used')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  ledger_group_id uuid,
  used_at timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX agent_advance_write_off_requests_one_open ON public.agent_advance_write_off_requests (advance_id)
  WHERE status IN ('requested', 'approved');
COMMENT ON TABLE public.agent_advance_write_off_requests IS
  'A write-off of an advance balance needs a request and an approval by a different CFO / CEO before cancel_agent_advance will '
  'close the advance. The approved write-off is posted DR X4 / CR A10, A11, A20 (key adv_writeoff:<id>).';

CREATE TABLE public.agent_advance_op_guard (
  key text PRIMARY KEY,
  op text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.agent_advance_op_guard IS
  'Duplicate-submission guard for advance operations: the same operation with the same inputs inside two minutes is refused.';

CREATE TABLE public.wallet_reversal_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  original_group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  advance_id uuid,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'posted', 'void')),
  reversal_group_id uuid UNIQUE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz
);
CREATE INDEX wallet_reversal_links_original ON public.wallet_reversal_links (original_group_id);
COMMENT ON TABLE public.wallet_reversal_links IS
  'Every wallet error correction that reverses a credit is linked to the credit''s transaction; the reserved + posted reversals of a '
  'credit can never exceed it. Reversing an advance payout credits the advance (A10) and reduces it instead of crediting E3.';

CREATE TABLE public.agent_advance_exception_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  counts jsonb NOT NULL,
  exceptions jsonb NOT NULL
);
COMMENT ON TABLE public.agent_advance_exception_runs IS 'Daily snapshot of get_agent_advance_exceptions() (run_agent_advance_reconciliation).';

DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_advance_transfers', 'agent_advance_write_off_requests', 'agent_advance_op_guard',
                           'wallet_reversal_links', 'agent_advance_exception_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('CREATE POLICY mfa_required_for_staff ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['agent_advance_transfers', 'agent_advance_write_off_requests', 'wallet_reversal_links', 'agent_advance_exception_runs'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY finance_reads ON public.%I FOR SELECT TO authenticated USING ('
      '(select public.has_role((select auth.uid()), ''cfo''::app_role)) OR (select public.has_role((select auth.uid()), ''ceo''::app_role)) '
      'OR (select public.has_role((select auth.uid()), ''coo''::app_role)) OR (select public.has_role((select auth.uid()), ''manager''::app_role)) '
      'OR (select public.has_role((select auth.uid()), ''super_admin''::app_role)))', t);
  END LOOP;
END $grants$;

-- ---------------------------------------------------------------- 2. what the books carry for one advance
-- Entry-level: every platform / bridge leg on the advance, its request or its top-ups, in reportable groups. The rules match
-- the balance-sheet resolver per category (checked against sofp_ledger_legs 2026-11-04).
CREATE OR REPLACE FUNCTION public._agent_advance_book_balance(p_advance uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH a AS (SELECT id, request_id FROM public.agent_advances WHERE id = p_advance),
  l AS (
    SELECT g.category c, g.direction d, g.amount amt
    FROM public.general_ledger g, a
    WHERE g.ledger_scope IN ('platform', 'bridge')
      AND ((g.source_table = 'agent_advances' AND g.source_id = a.id)
        OR (g.source_table = 'agent_advance_requests' AND g.source_id = a.request_id AND a.request_id IS NOT NULL)
        OR (g.source_table = 'agent_advance_topups' AND g.source_id IN (SELECT t.id FROM public.agent_advance_topups t WHERE t.advance_id = a.id)))
      AND EXISTS (SELECT 1 FROM public.general_ledger x WHERE x.transaction_group_id = g.transaction_group_id
                    AND x.classification IN ('production', 'legacy_real')))
  SELECT jsonb_build_object(
    'a10', COALESCE(sum(CASE
      WHEN c IN ('rent_disbursement', 'agent_advance_disbursement', 'agent_advance_penalty_accrued') THEN CASE WHEN d = 'cash_out' THEN amt ELSE -amt END
      WHEN c IN ('agent_advance_receivable_opening', 'agent_advance_penalty_accrued_external') THEN CASE WHEN d = 'cash_in' THEN amt ELSE -amt END
      WHEN c IN ('agent_repayment', 'agent_advance_repayment', 'advance_repayment', 'agent_advance_written_off', 'agent_advance_reversed')
        THEN CASE WHEN d = 'cash_out' THEN amt ELSE -amt END END), 0),
    'a11', COALESCE(sum(CASE
      WHEN c IN ('agent_advance_access_fee_charged', 'agent_advance_access_fee_collected', 'agent_advance_access_fee_written_off')
        THEN CASE WHEN d = 'cash_out' THEN amt ELSE -amt END
      WHEN c IN ('agent_access_fee_receivable_opening', 'agent_advance_access_fee_collected_external') THEN CASE WHEN d = 'cash_in' THEN amt ELSE -amt END END), 0),
    'a20', COALESCE(sum(CASE
      WHEN c IN ('agent_advance_registration_fee_charged', 'agent_advance_registration_fee_collected', 'agent_advance_registration_fee_written_off')
        THEN CASE WHEN d = 'cash_out' THEN amt ELSE -amt END
      WHEN c = 'agent_advance_registration_fee_collected_external' THEN CASE WHEN d = 'cash_in' THEN amt ELSE -amt END END), 0))
  FROM l
$function$;

-- ---------------------------------------------------------------- 3. duplicate-submission guard
CREATE OR REPLACE FUNCTION public._agent_advance_guard(p_op text, p_parts text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_key text := p_op || ':' || md5(COALESCE(p_parts, '')); v_at timestamptz;
BEGIN
  SELECT created_at INTO v_at FROM public.agent_advance_op_guard WHERE key = v_key FOR UPDATE;
  IF FOUND AND v_at > now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'ADVANCE_DUPLICATE_SUBMISSION: the same % was submitted at % - it is not processed twice. Wait two minutes if it really is a second one.',
      replace(p_op, '_', ' '), to_char(v_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI:SS') USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO public.agent_advance_op_guard (key, op, created_by, created_at) VALUES (v_key, p_op, auth.uid(), now())
  ON CONFLICT (key) DO UPDATE SET created_at = now(), created_by = auth.uid();
END $function$;

-- ---------------------------------------------------------------- 4. a payout that looks like a transfer
-- A payout of exactly an existing advance's balance (or of the principal of an advance the same agent received in the last 7
-- days) is how balances were "moved" before: it paid the money out again. Such a payout needs "[NEW MONEY]" in the reason;
-- moving a balance goes through cfo_transfer_agent_advance.
CREATE OR REPLACE FUNCTION public._agent_advance_transfer_lookalike(p_agent uuid, p_amount numeric, p_exclude uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object('advance_id', a.id, 'agent_id', a.agent_id, 'status', a.status,
           'balance', COALESCE(NULLIF(a.outstanding_balance, 0), a.pre_cancel_outstanding), 'principal', a.principal, 'issued_at', a.issued_at)
  FROM public.agent_advances a
  WHERE a.id IS DISTINCT FROM p_exclude AND p_amount > 0
    AND (
      -- same agent: the balance of an open advance, or of one cancelled in the last 7 days (within 1%)
      (a.agent_id = p_agent AND (
         (a.status IN ('active', 'overdue') AND abs(a.outstanding_balance - p_amount) <= GREATEST(100, p_amount * 0.01))
      OR (a.status = 'cancelled' AND a.cancelled_at > now() - interval '7 days'
          AND abs(COALESCE(a.pre_cancel_outstanding, 0) - p_amount) <= GREATEST(100, p_amount * 0.01))
      OR (a.status IN ('active', 'overdue', 'cancelled') AND a.issued_at > now() - interval '7 days' AND a.principal = p_amount)))
      -- any agent: exactly the balance of an open advance (a cross-account move)
      OR (a.agent_id <> p_agent AND a.status IN ('active', 'overdue') AND abs(a.outstanding_balance - p_amount) <= 100
          AND a.outstanding_balance >= 100000))
  ORDER BY (a.agent_id = p_agent) DESC, abs(COALESCE(NULLIF(a.outstanding_balance, 0), a.pre_cancel_outstanding, a.principal) - p_amount)
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public._agent_advance_assert_new_money(p_agent uuid, p_amount numeric, p_exclude uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb;
BEGIN
  IF COALESCE(p_reason, '') ILIKE '%[NEW MONEY]%' THEN RETURN; END IF;
  v := public._agent_advance_transfer_lookalike(p_agent, p_amount, p_exclude);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'ADVANCE_POSSIBLE_TRANSFER: UGX % matches advance % (balance UGX %, principal UGX %). To move that balance use Transfer - it pays nothing out. To pay this amount out as new money, add [NEW MONEY] to the reason.',
      to_char(p_amount, 'FM999,999,999,990'), left(v->>'advance_id', 8),
      to_char((v->>'balance')::numeric, 'FM999,999,999,990'), to_char((v->>'principal')::numeric, 'FM999,999,999,990')
      USING ERRCODE = 'check_violation';
  END IF;
END $function$;

-- ---------------------------------------------------------------- 5. accounting-only transfer
CREATE OR REPLACE FUNCTION public.cfo_transfer_agent_advance(
  p_from_advance uuid, p_destination text, p_reason text, p_idempotency_key text,
  p_to_advance uuid DEFAULT NULL, p_amount numeric DEFAULT NULL,
  p_new_agent_id uuid DEFAULT NULL, p_new_recovery_source text DEFAULT NULL, p_new_roi_percent numeric DEFAULT NULL,
  p_new_cycle_days integer DEFAULT NULL, p_cross_account_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_prev public.agent_advance_transfers; f public.agent_advances; d public.agent_advances;
  v_amount numeric; v_book jsonb; v_a10 numeric; v_a11 numeric; v_a20 numeric; v_off numeric; v_rest numeric;
  v_to uuid; v_to_agent uuid; v_id uuid := gen_random_uuid(); v_group uuid; v_entries jsonb; v_desc text; v_after numeric;
  v_cycle integer; v_src text; v_roi numeric; v_inst integer;
BEGIN
  IF v_actor IS NOT NULL AND NOT public.can_act_pinned_finance_action(v_actor) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.' USING ERRCODE = '42501';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_actor, 'cfo'::app_role) OR public.has_role(v_actor, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can transfer advances';
  END IF;
  IF length(btrim(COALESCE(p_idempotency_key, ''))) < 8 THEN RAISE EXCEPTION 'An idempotency key of at least 8 characters is required'; END IF;
  SELECT * INTO v_prev FROM public.agent_advance_transfers WHERE idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_prev.from_advance_id <> p_from_advance THEN
      RAISE EXCEPTION 'Idempotency key % was already used for another transfer', p_idempotency_key;
    END IF;
    RETURN to_jsonb(v_prev) || jsonb_build_object('replayed', true);
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 15 THEN RAISE EXCEPTION 'A transfer reason of at least 15 characters is required'; END IF;
  IF p_destination NOT IN ('new_advance', 'existing_advance') THEN
    RAISE EXCEPTION 'Destination must be new_advance (replacement, ROI or partnership advance) or existing_advance';
  END IF;

  SELECT * INTO f FROM public.agent_advances WHERE id = p_from_advance FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found'; END IF;
  IF f.status NOT IN ('active', 'overdue') THEN RAISE EXCEPTION 'Only an open advance can be transferred (status %)', f.status; END IF;
  IF COALESCE(f.outstanding_balance, 0) <= 0 THEN RAISE EXCEPTION 'Nothing outstanding to transfer'; END IF;
  v_amount := round(COALESCE(p_amount, f.outstanding_balance), 2);
  IF v_amount <= 0 OR v_amount > f.outstanding_balance THEN
    RAISE EXCEPTION 'Transfer amount must be more than 0 and at most the outstanding balance (UGX %)', f.outstanding_balance;
  END IF;

  IF p_destination = 'existing_advance' THEN
    IF p_to_advance IS NULL THEN RAISE EXCEPTION 'Choose the advance that receives the balance'; END IF;
    SELECT * INTO d FROM public.agent_advances WHERE id = p_to_advance FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Destination advance not found'; END IF;
    IF d.id = f.id THEN RAISE EXCEPTION 'An advance cannot be transferred to itself'; END IF;
    IF d.status NOT IN ('active', 'overdue') THEN RAISE EXCEPTION 'The destination advance must be open (status %)', d.status; END IF;
    v_to := d.id; v_to_agent := d.agent_id;
  ELSE
    v_to_agent := COALESCE(p_new_agent_id, f.agent_id);
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_to_agent) THEN RAISE EXCEPTION 'Destination agent not found'; END IF;
    v_src := COALESCE(p_new_recovery_source, f.recovery_source, 'wallet_daily');
    IF v_src NOT IN ('wallet_daily', 'roi') THEN RAISE EXCEPTION 'Recovery source must be wallet_daily or roi'; END IF;
    v_roi := CASE WHEN v_src = 'roi' THEN p_new_roi_percent ELSE 0 END;
    IF v_src = 'roi' AND (v_roi IS NULL OR v_roi <= 0 OR v_roi > 100) THEN RAISE EXCEPTION 'ROI recovery needs a percentage between 0 and 100'; END IF;
    v_cycle := COALESCE(p_new_cycle_days, f.cycle_days, 30);
    IF v_cycle <= 0 THEN RAISE EXCEPTION 'Cycle days must be greater than zero'; END IF;
    v_inst := CASE COALESCE(f.repayment_frequency, 'daily') WHEN 'weekly' THEN GREATEST(1, ceil(v_cycle / 7.0)) WHEN 'biweekly' THEN GREATEST(1, ceil(v_cycle / 14.0))
                   WHEN 'monthly' THEN GREATEST(1, ceil(v_cycle / 30.0)) ELSE v_cycle END;
    -- the balance moves as principal: no new fee and no payout (funding_type 'transfer')
    INSERT INTO public.agent_advances (agent_id, principal, outstanding_balance, daily_rate, monthly_rate, cycle_days, issued_at, expires_at,
      status, issued_by, registration_fee, access_fee, access_fee_status, daily_installment, installment_amount, repayment_frequency,
      recovery_source, roi_recovery_percent, funding_type, transferred_from_advance_id, transfer_id)
    VALUES (v_to_agent, v_amount, v_amount, 0, 0, v_cycle, now(), now() + make_interval(days => v_cycle),
      'active', v_actor, 0, 0, 'paid', CASE WHEN v_src = 'wallet_daily' THEN ceil(v_amount / v_inst) ELSE 0 END, ceil(v_amount / v_inst),
      COALESCE(f.repayment_frequency, 'daily'), v_src, COALESCE(v_roi, 0), 'transfer', f.id, v_id)
    RETURNING id INTO v_to;
  END IF;
  IF v_to_agent <> f.agent_id AND length(btrim(COALESCE(p_cross_account_reason, ''))) < 15 THEN
    RAISE EXCEPTION 'Moving a balance to another account (partnership) needs a cross-account reason of at least 15 characters';
  END IF;

  -- what the books carry for the source moves with it; the rest of the amount was never booked (legacy)
  v_book := public._agent_advance_book_balance(f.id);
  v_rest := v_amount;
  v_a10 := LEAST(GREATEST((v_book->>'a10')::numeric, 0), v_rest); v_rest := v_rest - v_a10;
  v_a11 := LEAST(GREATEST((v_book->>'a11')::numeric, 0), v_rest); v_rest := v_rest - v_a11;
  v_a20 := LEAST(GREATEST((v_book->>'a20')::numeric, 0), v_rest); v_rest := v_rest - v_a20;
  v_off := v_rest;
  v_desc := 'Advance balance transferred (no money moved): ' || left(f.id::text, 8) || ' -> ' || left(v_to::text, 8) || ' - ' || btrim(p_reason);
  v_entries := jsonb_build_array(jsonb_build_object('user_id', v_to_agent, 'ledger_scope', 'bridge', 'direction', 'cash_in', 'amount', v_amount,
      'category', 'agent_advance_receivable_opening', 'source_table', 'agent_advances', 'source_id', v_to, 'reference_id', v_id::text,
      'currency', 'UGX', 'description', v_desc));
  IF v_a10 > 0 THEN v_entries := v_entries || jsonb_build_object('user_id', f.agent_id, 'ledger_scope', 'bridge', 'direction', 'cash_out', 'amount', v_a10,
      'category', 'agent_advance_receivable_opening', 'source_table', 'agent_advances', 'source_id', f.id, 'reference_id', v_id::text, 'currency', 'UGX', 'description', v_desc); END IF;
  IF v_a11 > 0 THEN v_entries := v_entries || jsonb_build_object('user_id', f.agent_id, 'ledger_scope', 'bridge', 'direction', 'cash_out', 'amount', v_a11,
      'category', 'agent_access_fee_receivable_opening', 'source_table', 'agent_advances', 'source_id', f.id, 'reference_id', v_id::text, 'currency', 'UGX', 'description', v_desc); END IF;
  IF v_a20 > 0 THEN v_entries := v_entries || jsonb_build_object('user_id', f.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_a20,
      'category', 'agent_advance_registration_fee_collected_external', 'source_table', 'agent_advances', 'source_id', f.id, 'reference_id', v_id::text, 'currency', 'UGX', 'description', v_desc); END IF;
  IF v_off > 0 THEN v_entries := v_entries || jsonb_build_object('user_id', f.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_off,
      'category', 'receivable_restatement_equity', 'source_table', 'agent_advances', 'source_id', f.id, 'reference_id', v_id::text, 'currency', 'UGX',
      'description', v_desc || ' (amount the books never carried: legacy fees / penalties)'); END IF;
  v_group := public.create_ledger_transaction(entries => v_entries, idempotency_key => 'adv_transfer:' || v_id::text);

  IF p_destination = 'existing_advance' THEN
    UPDATE public.agent_advances SET principal = principal + v_amount, outstanding_balance = outstanding_balance + v_amount, updated_at = now() WHERE id = v_to;
  END IF;
  v_after := f.outstanding_balance - v_amount;
  IF v_after <= 0 THEN
    UPDATE public.agent_advances SET status = 'cancelled', outstanding_balance = 0, arrears_balance = 0, daily_installment = 0,
      cancelled_at = now(), cancelled_by = v_actor, cancellation_mode = 'transfer', pre_cancel_outstanding = f.outstanding_balance,
      cancellation_reason = 'Transferred to advance ' || v_to::text || ': ' || btrim(p_reason), updated_at = now()
    WHERE id = f.id;
  ELSE
    UPDATE public.agent_advances SET outstanding_balance = v_after, arrears_balance = LEAST(COALESCE(arrears_balance, 0), v_after), updated_at = now() WHERE id = f.id;
  END IF;

  INSERT INTO public.agent_advance_transfers (id, idempotency_key, from_advance_id, to_advance_id, destination_type, from_agent_id, to_agent_id,
    cross_account_reason, amount, moved_a10, moved_a11, moved_a20, not_previously_booked, from_outstanding_before, from_outstanding_after,
    source_closed, ledger_group_id, reason, created_by)
  VALUES (v_id, btrim(p_idempotency_key), f.id, v_to, p_destination, f.agent_id, v_to_agent, NULLIF(btrim(COALESCE(p_cross_account_reason, '')), ''),
    v_amount, v_a10, v_a11, v_a20, v_off, f.outstanding_balance, GREATEST(v_after, 0), v_after <= 0, v_group, btrim(p_reason), v_actor);
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'agent_advance_transferred', 'agent_advances', f.id::text, btrim(p_reason),
    jsonb_build_object('transfer_id', v_id, 'to_advance', v_to, 'destination', p_destination, 'amount', v_amount, 'to_agent', v_to_agent,
      'moved_a10', v_a10, 'moved_a11', v_a11, 'moved_a20', v_a20, 'not_previously_booked', v_off, 'ledger_group_id', v_group, 'wallet_movement', false));
  RETURN jsonb_build_object('transfer_id', v_id, 'to_advance_id', v_to, 'amount', v_amount, 'source_closed', v_after <= 0,
    'moved_a10', v_a10, 'moved_a11', v_a11, 'moved_a20', v_a20, 'not_previously_booked', v_off, 'ledger_group_id', v_group, 'replayed', false);
END $function$;

-- ---------------------------------------------------------------- 6. approved write-offs
CREATE OR REPLACE FUNCTION public.request_agent_advance_write_off(p_advance_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid := auth.uid(); a public.agent_advances; v_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT public.can_act_pinned_finance_action(v_actor)
     OR NOT (public.has_role(v_actor, 'cfo'::app_role) OR public.has_role(v_actor, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can request a write-off' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 20 THEN RAISE EXCEPTION 'A write-off reason of at least 20 characters is required'; END IF;
  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found'; END IF;
  IF a.status NOT IN ('active', 'overdue') OR COALESCE(a.outstanding_balance, 0) <= 0 THEN RAISE EXCEPTION 'Only an open advance with a balance can be written off'; END IF;
  INSERT INTO public.agent_advance_write_off_requests (advance_id, amount, reason, requested_by)
  VALUES (a.id, a.outstanding_balance, btrim(p_reason), v_actor) RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'agent_advance_write_off_requested', 'agent_advances', a.id::text, btrim(p_reason), jsonb_build_object('request_id', v_id, 'amount', a.outstanding_balance));
  RETURN jsonb_build_object('request_id', v_id, 'amount', a.outstanding_balance, 'status', 'requested');
END $function$;

CREATE OR REPLACE FUNCTION public.decide_agent_advance_write_off(p_request_id uuid, p_approve boolean, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid := auth.uid(); r public.agent_advance_write_off_requests;
BEGIN
  IF v_actor IS NULL OR NOT (public.has_role(v_actor, 'cfo'::app_role) OR public.has_role(v_actor, 'ceo'::app_role)) OR NOT public.staff_mfa_ok() THEN
    RAISE EXCEPTION 'Only the CFO or CEO can decide a write-off' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 10 THEN RAISE EXCEPTION 'A decision note of at least 10 characters is required'; END IF;
  SELECT * INTO r FROM public.agent_advance_write_off_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Write-off request not found'; END IF;
  IF r.status <> 'requested' THEN RAISE EXCEPTION 'This write-off request is already %', r.status; END IF;
  IF r.requested_by = v_actor THEN RAISE EXCEPTION 'A write-off must be approved by someone other than the person who requested it'; END IF;
  UPDATE public.agent_advance_write_off_requests SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    decided_by = v_actor, decided_at = now(), decision_note = btrim(p_note) WHERE id = r.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, CASE WHEN p_approve THEN 'agent_advance_write_off_approved' ELSE 'agent_advance_write_off_rejected' END,
    'agent_advances', r.advance_id::text, btrim(p_note), jsonb_build_object('request_id', r.id, 'amount', r.amount));
  RETURN jsonb_build_object('request_id', r.id, 'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END $function$;

-- posts an approved write-off: DR X4 / CR the advance's A10, A11, A20 (what the books carry). Called by cancel_agent_advance.
CREATE OR REPLACE FUNCTION public._agent_advance_post_write_off(p_request_id uuid, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.agent_advance_write_off_requests; a public.agent_advances; v_book jsonb; v_a10 numeric; v_a11 numeric; v_a20 numeric;
  v_entries jsonb := '[]'::jsonb; v_group uuid; v_desc text;
BEGIN
  SELECT * INTO r FROM public.agent_advance_write_off_requests WHERE id = p_request_id FOR UPDATE;
  SELECT * INTO a FROM public.agent_advances WHERE id = r.advance_id;
  v_book := public._agent_advance_book_balance(a.id);
  v_a10 := GREATEST((v_book->>'a10')::numeric, 0); v_a11 := GREATEST((v_book->>'a11')::numeric, 0); v_a20 := GREATEST((v_book->>'a20')::numeric, 0);
  v_desc := 'Approved write-off of advance ' || left(a.id::text, 8) || ': ' || r.reason;
  IF v_a10 + v_a11 + v_a20 > 0 THEN
    v_entries := jsonb_build_array(jsonb_build_object('user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_a10 + v_a11 + v_a20,
      'category', 'platform_loss_writeoff', 'source_table', 'agent_advances', 'source_id', a.id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc));
    IF v_a10 > 0 THEN v_entries := v_entries || jsonb_build_object('user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_a10,
      'category', 'agent_advance_written_off', 'source_table', 'agent_advances', 'source_id', a.id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc); END IF;
    IF v_a11 > 0 THEN v_entries := v_entries || jsonb_build_object('user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_a11,
      'category', 'agent_advance_access_fee_written_off', 'source_table', 'agent_advances', 'source_id', a.id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc); END IF;
    IF v_a20 > 0 THEN v_entries := v_entries || jsonb_build_object('user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_a20,
      'category', 'agent_advance_registration_fee_written_off', 'source_table', 'agent_advances', 'source_id', a.id, 'reference_id', r.id::text, 'currency', 'UGX', 'description', v_desc); END IF;
    v_group := public.create_ledger_transaction(entries => v_entries, idempotency_key => 'adv_writeoff:' || r.id::text);
  END IF;
  UPDATE public.agent_advance_write_off_requests SET status = 'used', used_at = now(), ledger_group_id = v_group WHERE id = r.id;
  RETURN v_group;
END $function$;

-- ---------------------------------------------------------------- 7. linked wallet reversals (finops-wallet-move error corrections)
-- Reserve a reversal of (part of) a credit: the credit must be a wallet cash_in of that user in that transaction, and all reserved
-- and posted reversals of it together can never exceed it. A reversal of an advance payout credits the advance (A10).
CREATE OR REPLACE FUNCTION public.reserve_wallet_reversal(p_original_group uuid, p_user uuid, p_amount numeric, p_reference text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_credit numeric; v_done numeric; v_adv uuid; v_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'REVERSAL_AMOUNT_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wallet_reversal:' || p_original_group::text));
  SELECT COALESCE(sum(amount), 0) INTO v_credit FROM public.general_ledger
   WHERE transaction_group_id = p_original_group AND user_id = p_user AND ledger_scope = 'wallet' AND direction = 'cash_in';
  IF v_credit <= 0 THEN RAISE EXCEPTION 'REVERSAL_ORIGINAL_NOT_FOUND: transaction % has no wallet credit for this user', p_original_group; END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_done FROM public.wallet_reversal_links
   WHERE original_group_id = p_original_group AND status IN ('reserved', 'posted');
  IF v_done + p_amount > v_credit THEN
    RAISE EXCEPTION 'REVERSAL_EXCEEDS_ORIGINAL: UGX % requested, but the original credit was UGX % and UGX % has already been reversed (UGX % left)',
      p_amount, v_credit, v_done, v_credit - v_done USING ERRCODE = 'check_violation';
  END IF;
  -- an advance payout: the advance the credit funded
  SELECT a.id INTO v_adv FROM public.general_ledger g
    JOIN public.agent_advances a ON (g.source_table = 'agent_advances' AND a.id = g.source_id)
      OR (g.source_table = 'agent_advance_requests' AND a.request_id = g.source_id)
      OR (g.source_table = 'agent_advance_topups' AND a.id = (SELECT t.advance_id FROM public.agent_advance_topups t WHERE t.id = g.source_id))
   WHERE g.transaction_group_id = p_original_group AND g.ledger_scope = 'platform'
     AND g.category IN ('agent_advance_disbursement', 'rent_disbursement') LIMIT 1;
  INSERT INTO public.wallet_reversal_links (reference, original_group_id, user_id, amount, advance_id, created_by)
  VALUES (p_reference, p_original_group, p_user, p_amount, v_adv, p_actor) RETURNING id INTO v_id;
  RETURN jsonb_build_object('link_id', v_id, 'advance_id', v_adv,
    'platform_category', CASE WHEN v_adv IS NOT NULL THEN 'agent_advance_reversed' ELSE NULL END,
    'remaining_after', v_credit - v_done - p_amount);
END $function$;

CREATE OR REPLACE FUNCTION public.settle_wallet_reversal(p_link_id uuid, p_reversal_group uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE l public.wallet_reversal_links; a public.agent_advances; v_after numeric;
BEGIN
  SELECT * INTO l FROM public.wallet_reversal_links WHERE id = p_link_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reversal link not found'; END IF;
  IF l.status <> 'reserved' THEN RETURN jsonb_build_object('link_id', l.id, 'status', l.status, 'already', true); END IF;
  IF p_reversal_group IS NULL THEN
    UPDATE public.wallet_reversal_links SET status = 'void' WHERE id = l.id;
    RETURN jsonb_build_object('link_id', l.id, 'status', 'void');
  END IF;
  UPDATE public.wallet_reversal_links SET status = 'posted', reversal_group_id = p_reversal_group, posted_at = now() WHERE id = l.id;
  IF l.advance_id IS NOT NULL THEN
    SELECT * INTO a FROM public.agent_advances WHERE id = l.advance_id FOR UPDATE;
    v_after := GREATEST(COALESCE(a.outstanding_balance, 0) - l.amount, 0);
    UPDATE public.agent_advances SET principal = GREATEST(principal - l.amount, 0), outstanding_balance = v_after,
      status = CASE WHEN v_after <= 0 AND status IN ('active', 'overdue') THEN 'cancelled' ELSE status END,
      cancellation_mode = CASE WHEN v_after <= 0 AND status IN ('active', 'overdue') THEN 'payout_reversed' ELSE cancellation_mode END,
      cancelled_at = CASE WHEN v_after <= 0 AND status IN ('active', 'overdue') THEN now() ELSE cancelled_at END,
      pre_cancel_outstanding = CASE WHEN v_after <= 0 AND status IN ('active', 'overdue') THEN a.outstanding_balance ELSE pre_cancel_outstanding END,
      cancellation_reason = CASE WHEN v_after <= 0 AND status IN ('active', 'overdue') THEN 'Payout returned by wallet reversal ' || l.reference ELSE cancellation_reason END,
      daily_installment = CASE WHEN v_after <= 0 THEN 0 ELSE daily_installment END, updated_at = now()
    WHERE id = a.id;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (l.created_by, 'agent_advance_payout_reversed', 'agent_advances', a.id::text, l.reference,
      jsonb_build_object('amount', l.amount, 'original_group', l.original_group_id, 'reversal_group', p_reversal_group, 'outstanding_after', v_after));
  END IF;
  RETURN jsonb_build_object('link_id', l.id, 'status', 'posted', 'advance_id', l.advance_id);
END $function$;

-- ---------------------------------------------------------------- 8. reconciliation and exceptions
CREATE OR REPLACE FUNCTION public.get_agent_advance_exceptions()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE v_out jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role)
       OR public.has_role(auth.uid(), 'coo'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  WITH adv AS MATERIALIZED (
    SELECT a.*, public._agent_advance_book_balance(a.id) book FROM public.agent_advances a),
  credits AS MATERIALIZED (   -- every advance payout to a wallet
    SELECT g.transaction_group_id gid, g.user_id, g.amount, g.created_at FROM public.general_ledger g
    WHERE g.ledger_scope = 'wallet' AND g.direction = 'cash_in' AND g.category = 'agent_advance_credit' AND g.wallet_bucket = 'withdrawable'),
  ecw AS MATERIALIZED (       -- every wallet error correction (finops-wallet-move) back to the platform
    SELECT g.transaction_group_id gid, g.user_id, g.amount, g.created_at FROM public.general_ledger g
    WHERE g.ledger_scope = 'wallet' AND g.direction = 'cash_out' AND g.source_table = 'finops_wallet_move' AND g.description LIKE 'Error correction:%'),
  matched AS MATERIALIZED (   -- each correction against the nearest earlier payout of a similar amount (within 10%) in 7 days
    SELECT DISTINCT ON (e.gid) c.gid c_gid, c.user_id, c.amount c_amount, c.created_at c_at, e.gid e_gid, e.amount e_amount, e.created_at e_at
    FROM ecw e JOIN credits c ON c.user_id = e.user_id AND c.created_at < e.created_at AND c.created_at > e.created_at - interval '7 days'
      AND e.amount BETWEEN c.amount * 0.9 AND c.amount * 1.1
    WHERE NOT EXISTS (SELECT 1 FROM public.wallet_reversal_links w WHERE w.reversal_group_id = e.gid)
    ORDER BY e.gid, c.created_at DESC),
  ex AS (
    SELECT 'closed_with_book_balance' kind, 'high' severity, a.id advance_id, a.agent_id,
      jsonb_build_object('status', a.status, 'mode', a.cancellation_mode, 'book', a.book) detail
    FROM adv a WHERE (a.status = 'completed' OR (a.status = 'cancelled' AND COALESCE(a.cancellation_mode, '') <> 'recoup_from_wallet'))
      AND abs((a.book->>'a10')::numeric) + abs((a.book->>'a11')::numeric) + abs((a.book->>'a20')::numeric) >= 1
    UNION ALL
    SELECT 'undocumented_cancellation', 'high', a.id, a.agent_id,
      jsonb_build_object('mode', a.cancellation_mode, 'pre_cancel_outstanding', a.pre_cancel_outstanding, 'reason', a.cancellation_reason, 'cancelled_at', a.cancelled_at)
    FROM adv a WHERE a.status = 'cancelled' AND COALESCE(a.pre_cancel_outstanding, 0) > 0 AND COALESCE(a.cancellation_mode, 'write_off') = 'write_off'
    UNION ALL
    SELECT 'payout_returned_by_unlinked_correction', 'high', NULL, m.user_id,
      jsonb_build_object('payout_group', m.c_gid, 'payout', m.c_amount, 'paid_at', m.c_at, 'correction_group', m.e_gid, 'returned', m.e_amount, 'returned_at', m.e_at)
    FROM matched m
    UNION ALL
    SELECT 'reversal_exceeds_original', 'high', NULL, m.user_id,
      jsonb_build_object('payout_group', m.c_gid, 'payout', m.c_amount, 'correction_group', m.e_gid, 'returned', m.e_amount, 'excess', m.e_amount - m.c_amount)
    FROM matched m WHERE m.e_amount > m.c_amount
    UNION ALL
    SELECT 'duplicate_payout', 'high', NULL, c1.user_id,
      jsonb_build_object('first_group', c1.gid, 'second_group', c2.gid, 'amount', c1.amount, 'first_at', c1.created_at, 'second_at', c2.created_at)
    FROM credits c1 JOIN credits c2 ON c2.user_id = c1.user_id AND c2.amount = c1.amount AND c2.created_at > c1.created_at
      AND c2.created_at < c1.created_at + interval '48 hours' AND c2.gid <> c1.gid
    UNION ALL
    SELECT 'live_book_mismatch', CASE WHEN a.issued_at < '2026-09-29' THEN 'legacy' ELSE 'medium' END, a.id, a.agent_id,
      jsonb_build_object('record_outstanding', a.outstanding_balance, 'book', a.book,
        'difference', a.outstanding_balance - (a.book->>'a10')::numeric - (a.book->>'a11')::numeric - (a.book->>'a20')::numeric)
    FROM adv a WHERE (a.status IN ('active', 'overdue') OR (a.status = 'cancelled' AND a.cancellation_mode = 'recoup_from_wallet'))
      AND abs(a.outstanding_balance - (a.book->>'a10')::numeric - (a.book->>'a11')::numeric - (a.book->>'a20')::numeric) >= 1000)
  SELECT jsonb_build_object('as_at', now(),
    'counts', COALESCE((SELECT jsonb_object_agg(kind, n) FROM (SELECT kind, count(*) n FROM ex GROUP BY kind) z), '{}'::jsonb),
    'exceptions', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'severity', severity, 'advance_id', advance_id, 'agent_id', agent_id,
        'agent', (SELECT full_name FROM public.profiles p WHERE p.id = ex.agent_id), 'detail', detail) ORDER BY kind, agent_id) FROM ex), '[]'::jsonb))
  INTO v_out;
  RETURN v_out;
END $function$;

CREATE OR REPLACE FUNCTION public.run_agent_advance_reconciliation()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb; v_id uuid;
BEGIN
  v := public.get_agent_advance_exceptions();
  INSERT INTO public.agent_advance_exception_runs (counts, exceptions) VALUES (v->'counts', v->'exceptions') RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule('agent-advance-reconciliation', '30 2 * * *', 'select public.run_agent_advance_reconciliation()');
  END IF;
END $cron$;

REVOKE ALL ON FUNCTION public._agent_advance_book_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._agent_advance_guard(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._agent_advance_transfer_lookalike(uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._agent_advance_assert_new_money(uuid, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._agent_advance_post_write_off(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_wallet_reversal(uuid, uuid, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_wallet_reversal(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_agent_advance_reconciliation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_wallet_reversal(uuid, uuid, numeric, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_wallet_reversal(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.cfo_transfer_agent_advance(uuid, text, text, text, uuid, numeric, uuid, text, numeric, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_transfer_agent_advance(uuid, text, text, text, uuid, numeric, uuid, text, numeric, integer, text) TO authenticated;
REVOKE ALL ON FUNCTION public.request_agent_advance_write_off(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_agent_advance_write_off(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.decide_agent_advance_write_off(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_agent_advance_write_off(uuid, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_agent_advance_exceptions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_advance_exceptions() TO authenticated;

-- ---------------------------------------------------------------- 9. existing functions (production text + the controls)
CREATE OR REPLACE FUNCTION public.cancel_agent_advance(p_advance_id uuid, p_recoup boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller UUID := auth.uid();
  v_adv RECORD;
  v_mode TEXT;
  v_prev_outstanding NUMERIC;
  v_wo public.agent_advance_write_off_requests;
  v_group UUID;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can cancel advances';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A cancellation reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;

  IF v_adv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Advance already cancelled';
  END IF;
  IF v_adv.status = 'completed' THEN
    RAISE EXCEPTION 'Advance already completed';
  END IF;

  v_mode := CASE WHEN p_recoup THEN 'recoup_from_wallet' ELSE 'write_off' END;
  v_prev_outstanding := v_adv.outstanding_balance;

  -- 2026-11-04 controls: a balance is never dropped silently. It is moved with cfo_transfer_agent_advance (replacement,
  -- existing, ROI or partnership advance - no money moves), kept (recoup), or written off after a write-off request was
  -- approved by someone else; the approved write-off is posted DR X4 / CR A10, A11, A20.
  IF NOT p_recoup AND COALESCE(v_adv.outstanding_balance, 0) > 0 THEN
    SELECT * INTO v_wo FROM public.agent_advance_write_off_requests
     WHERE advance_id = p_advance_id AND status = 'approved' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ADVANCE_CANCEL_NEEDS_DESTINATION: UGX % is still owed on this advance. Move it with Transfer (replacement, existing, ROI or partnership advance), keep it to recover from the wallet, or request a write-off and have it approved by another CFO or the CEO before cancelling.',
        to_char(v_adv.outstanding_balance, 'FM999,999,999,990') USING ERRCODE = 'check_violation';
    END IF;
    v_group := public._agent_advance_post_write_off(v_wo.id, v_caller);
    v_mode := 'write_off_approved';
  END IF;

  IF p_recoup THEN
    -- Keep outstanding intact; CFO will record wallet recovery via existing
    -- "Record Payment" flow. Deductions still stop because status != active.
    UPDATE public.agent_advances SET
      status = 'cancelled',
      daily_installment = 0,
      cancelled_at = now(),
      cancelled_by = v_caller,
      cancellation_reason = p_reason,
      cancellation_mode = v_mode,
      pre_cancel_outstanding = v_prev_outstanding,
      updated_at = now()
    WHERE id = p_advance_id;
  ELSE
    -- Full write-off
    UPDATE public.agent_advances SET
      status = 'cancelled',
      outstanding_balance = 0,
      arrears_balance = 0,
      daily_installment = 0,
      cancelled_at = now(),
      cancelled_by = v_caller,
      cancellation_reason = p_reason,
      cancellation_mode = v_mode,
      pre_cancel_outstanding = v_prev_outstanding,
      updated_at = now()
    WHERE id = p_advance_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller,
    'agent_advance_cancelled',
    'agent_advances',
    p_advance_id,
    jsonb_build_object(
      'mode', v_mode,
      'reason', p_reason,
      'previous_outstanding', v_prev_outstanding,
      'agent_id', v_adv.agent_id,
      'principal', v_adv.principal,
      'write_off_request', v_wo.id,
      'ledger_group_id', v_group
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'mode', v_mode,
    'previous_outstanding', v_prev_outstanding,
    'new_outstanding', CASE WHEN p_recoup THEN v_prev_outstanding ELSE 0 END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_create_advance(p_agent_id uuid, p_principal numeric, p_cycle_days integer, p_monthly_rate numeric, p_repayment_frequency text, p_reason text, p_override boolean DEFAULT false, p_override_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_gates jsonb; v_gate_list text[];
  v_reg_fee numeric; v_access_fee numeric; v_total numeric;
  v_installments integer; v_installment numeric;
  v_freq text := COALESCE(NULLIF(btrim(COALESCE(p_repayment_frequency,'')), ''), 'daily');
  v_req public.agent_advance_requests;
BEGIN

  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION 'This request could not be completed';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  IF NOT (
    has_role(v_actor, 'cfo'::app_role) OR has_role(v_actor, 'ceo'::app_role)
    OR has_role(v_actor, 'super_admin'::app_role) OR has_role(v_actor, 'admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to initiate an advance';
  END IF;

  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'An agent must be selected'; END IF;
  IF p_principal IS NULL OR p_principal <= 0 THEN RAISE EXCEPTION 'Principal must be greater than zero'; END IF;
  IF p_cycle_days IS NULL OR p_cycle_days <= 0 THEN RAISE EXCEPTION 'Cycle days must be greater than zero'; END IF;
  IF p_monthly_rate IS NULL OR p_monthly_rate < 0 OR p_monthly_rate > 1 THEN
    RAISE EXCEPTION 'Monthly rate must be between 0%% and 100%%';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 15 THEN
    RAISE EXCEPTION 'A reason of at least 15 characters is required';
  END IF;
  IF v_freq NOT IN ('daily','weekly','biweekly','monthly') THEN
    RAISE EXCEPTION 'Unknown repayment frequency: %', v_freq;
  END IF;
  IF p_override AND NULLIF(btrim(COALESCE(p_override_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION 'ADVANCE_OVERRIDE_REASON_REQUIRED: state why the eligibility gates are being bypassed.';
  END IF;

  -- 2026-11-04 controls: the same request twice inside two minutes is refused; a principal equal to an existing balance is
  -- a transfer (no payout) unless the reason says [NEW MONEY].
  PERFORM public._agent_advance_guard('advance_create', concat_ws('|', v_actor, p_agent_id, p_principal, btrim(COALESCE(p_reason, ''))));
  PERFORM public._agent_advance_assert_new_money(p_agent_id, p_principal, NULL, COALESCE(p_reason, '') || ' ' || COALESCE(p_override_reason, ''));

  v_gates := public.agent_advance_blocking_gates(p_agent_id, p_principal, p_monthly_rate);
  SELECT array_agg(g) INTO v_gate_list FROM jsonb_array_elements_text(v_gates->'gates') g;

  v_reg_fee    := CASE WHEN p_principal <= 200000 THEN 10000 ELSE 20000 END;
  v_access_fee := round(p_principal * p_monthly_rate * (p_cycle_days::numeric / 30));
  v_total      := p_principal + v_access_fee + v_reg_fee;

  v_installments := CASE v_freq
    WHEN 'weekly'   THEN GREATEST(1, ceil(p_cycle_days::numeric / 7))
    WHEN 'biweekly' THEN GREATEST(1, ceil(p_cycle_days::numeric / 14))
    WHEN 'monthly'  THEN GREATEST(1, ceil(p_cycle_days::numeric / 30))
    ELSE GREATEST(1, p_cycle_days)
  END;
  v_installment := ceil(v_total / v_installments);

  INSERT INTO public.agent_advance_requests (
    agent_id, principal, cycle_days, monthly_rate, access_fee, registration_fee,
    total_payable, daily_payment, repayment_frequency, reason, status,
    cfo_approved_by, cfo_approved_at,
    gate_override, gate_override_by, gate_override_at, gate_override_reason, gate_override_gates
  ) VALUES (
    p_agent_id, p_principal, p_cycle_days, p_monthly_rate, v_access_fee, v_reg_fee,
    v_total, v_installment, v_freq, '[CFO-initiated] ' || btrim(p_reason), 'cfo_approved',
    v_actor, v_now,
    COALESCE(p_override, false),
    CASE WHEN p_override THEN v_actor END,
    CASE WHEN p_override THEN v_now END,
    CASE WHEN p_override THEN btrim(p_override_reason) END,
    CASE WHEN p_override THEN v_gate_list END
  ) RETURNING * INTO v_req;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_actor,
    CASE WHEN COALESCE(p_override, false) THEN 'cfo_advance_gate_override' ELSE 'cfo_initiated_advance' END,
    'agent_advance_requests', v_req.id::text,
    CASE WHEN COALESCE(p_override, false) THEN btrim(p_override_reason) ELSE btrim(p_reason) END,
    jsonb_build_object(
      'agent_id', p_agent_id, 'principal', p_principal, 'cycle_days', p_cycle_days,
      'monthly_rate', p_monthly_rate, 'repayment_frequency', v_freq,
      'access_fee', v_access_fee, 'registration_fee', v_reg_fee,
      'total_payable', v_total, 'installment', v_installment,
      'override', COALESCE(p_override, false), 'gates_at_issue', v_gates, 'reason', btrim(p_reason)
    )
  );

  RETURN jsonb_build_object(
    'request', to_jsonb(v_req), 'gates_at_issue', v_gates,
    'access_fee', v_access_fee, 'registration_fee', v_reg_fee,
    'total_payable', v_total, 'installment', v_installment, 'installments', v_installments
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.disburse_agent_advance_request(p_request_id uuid, p_principal numeric DEFAULT NULL::numeric, p_cycle_days integer DEFAULT NULL::integer, p_monthly_rate numeric DEFAULT NULL::numeric, p_repayment_frequency text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_skip_reason text DEFAULT NULL::text, p_recovery_source text DEFAULT 'wallet_daily'::text, p_roi_recovery_percent numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_req public.agent_advance_requests;
  v_principal numeric; v_cycle integer; v_rate numeric; v_freq text;
  v_reg_fee numeric; v_access_fee numeric; v_total numeric;
  v_installments integer; v_installment numeric; v_notes text;
  v_advance_id uuid; v_now timestamptz := now(); v_group uuid; v_override boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT (
    has_role(v_actor, 'super_admin'::app_role) OR has_role(v_actor, 'manager'::app_role)
    OR has_role(v_actor, 'cfo'::app_role) OR has_role(v_actor, 'coo'::app_role)
    OR has_role(v_actor, 'ceo'::app_role) OR has_role(v_actor, 'operations'::app_role)
    OR has_role(v_actor, 'agent_ops'::app_role) OR has_role(v_actor, 'financial_ops'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions sp
      WHERE sp.user_id = v_actor AND sp.permitted_dashboard IN ('agent-ops','financial-ops','company-ops')
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to disburse agent advances';
  END IF;
  IF NULLIF(p_skip_reason, '') IS NOT NULL THEN
    RAISE EXCEPTION 'CFO approval is mandatory — the skip-CFO path has been removed';
  END IF;
  SELECT * INTO v_req FROM public.agent_advance_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance request not found'; END IF;
  v_override := COALESCE(v_req.gate_override, false);
  IF COALESCE(v_req.request_kind, 'new') <> 'new' THEN
    RAISE EXCEPTION 'Top-up requests must be merged with apply_advance_topup';
  END IF;
  IF v_req.status NOT IN ('cfo_approved','cfo_paid') THEN
    RAISE EXCEPTION 'Disbursement blocked — CFO approval is required (request status is %)', v_req.status;
  END IF;
  IF v_req.cfo_approved_by IS NULL OR v_req.cfo_approved_at IS NULL THEN
    RAISE EXCEPTION 'Disbursement blocked — this request has no recorded CFO approval';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_advances WHERE request_id = p_request_id) THEN
    RAISE EXCEPTION 'This request has already been disbursed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE source_table = 'agent_advance_requests' AND source_id = p_request_id
      AND category = 'agent_advance_credit'
  ) THEN
    RAISE EXCEPTION 'A wallet credit already exists for this request';
  END IF;
  v_principal := COALESCE(p_principal, v_req.principal);
  v_cycle     := COALESCE(p_cycle_days, v_req.cycle_days);
  v_rate      := COALESCE(p_monthly_rate, v_req.monthly_rate);
  v_freq      := COALESCE(p_repayment_frequency, v_req.repayment_frequency, 'daily');
  IF v_cycle IS NULL OR v_cycle <= 0 THEN RAISE EXCEPTION 'Cycle days must be greater than zero'; END IF;
  IF v_override THEN
    IF v_principal IS NULL OR v_principal <= 0 THEN RAISE EXCEPTION 'Principal must be greater than zero'; END IF;
    IF v_rate IS NULL OR v_rate < 0 OR v_rate > 1 THEN
      RAISE EXCEPTION 'Monthly rate must be between 0%% and 100%%';
    END IF;
  ELSE
    IF v_principal IS NULL OR v_principal < 10000 THEN RAISE EXCEPTION 'Principal must be at least UGX 10,000'; END IF;
    IF v_rate IS NULL OR v_rate <= 0 OR v_rate > 0.33 THEN
      RAISE EXCEPTION 'Monthly rate must be greater than 0 and at most 33%%';
    END IF;
  END IF;
  -- 2026-11-04 controls: one payout per request inside two minutes; a payout equal to an existing balance needs [NEW MONEY]
  PERFORM public._agent_advance_guard('advance_disburse', p_request_id::text);
  PERFORM public._agent_advance_assert_new_money(v_req.agent_id, v_principal, NULL, COALESCE(v_req.reason, '') || ' ' || COALESCE(p_notes, ''));
  v_reg_fee    := CASE WHEN v_principal <= 200000 THEN 10000 ELSE 20000 END;
  v_access_fee := round(v_principal * v_rate * (v_cycle::numeric / 30));
  v_total      := v_principal + v_access_fee + v_reg_fee;
  v_installments := CASE v_freq
    WHEN 'weekly'   THEN GREATEST(1, ceil(v_cycle::numeric / 7))
    WHEN 'biweekly' THEN GREATEST(1, ceil(v_cycle::numeric / 14))
    WHEN 'monthly'  THEN GREATEST(1, ceil(v_cycle::numeric / 30))
    ELSE GREATEST(1, v_cycle)
  END;
  v_installment := ceil(v_total / v_installments);
  v_notes := NULLIF(p_notes, '');
  UPDATE public.agent_advance_requests SET
    status = 'cfo_paid',
    paid_by_cfo = COALESCE(paid_by_cfo, v_actor),
    cfo_paid_at = COALESCE(cfo_paid_at, v_now),
    cfo_adjusted_rate = CASE WHEN v_rate <> monthly_rate THEN v_rate ELSE cfo_adjusted_rate END,
    cfo_notes = COALESCE(v_notes, cfo_notes),
    principal = v_principal, cycle_days = v_cycle, registration_fee = v_reg_fee,
    access_fee = v_access_fee, total_payable = v_total, daily_payment = v_installment,
    monthly_rate = v_rate, repayment_frequency = v_freq, updated_at = v_now
  WHERE id = p_request_id;
  INSERT INTO public.agent_advances (
    agent_id, issued_by, request_id, principal, outstanding_balance, cycle_days,
    monthly_rate, daily_rate, access_fee, registration_fee, access_fee_collected,
    access_fee_status, status, repayment_frequency, installment_amount,
    daily_installment, expires_at, recovery_source, roi_recovery_percent, gate_override
  ) VALUES (
    v_req.agent_id, v_actor, p_request_id, v_principal, v_total, v_cycle,
    v_rate, v_rate, v_access_fee, v_reg_fee, 0,
    'unpaid', 'active', v_freq, v_installment,
    v_installment, v_now + make_interval(days => v_cycle),
    COALESCE(p_recovery_source, 'wallet_daily'),
    CASE WHEN p_recovery_source = 'roi' THEN COALESCE(p_roi_recovery_percent, 0) ELSE 0 END,
    v_override
  ) RETURNING id INTO v_advance_id;
  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', v_principal, 'category', 'agent_advance_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'agent_advance_requests', 'source_id', p_request_id,
        'description', 'Agent advance disbursement - ' || v_cycle || 'd @ ' || round(v_rate * 100) || '%',
        'currency', 'UGX', 'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', v_principal, 'category', 'agent_advance_disbursement',
        'source_table', 'agent_advances', 'source_id', v_advance_id,
        'description', 'Agent advance disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_disbursement:' || p_request_id::text, false
  );
  IF v_access_fee > 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_access_fee, 'category', 'agent_advance_access_fee_charged',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance access fee charged at origination',
          'currency', 'UGX', 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_access_fee, 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance access fee revenue (origination)',
          'currency', 'UGX', 'transaction_date', v_now
        )
      ),
      'advance_access_fee:' || p_request_id::text, false
    );
  END IF;
  IF v_reg_fee > 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_reg_fee, 'category', 'agent_advance_registration_fee_charged',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance registration fee charged at origination',
          'currency', 'UGX', 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', v_req.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_reg_fee, 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', v_advance_id,
          'description', 'Agent Advance registration fee revenue (origination)',
          'currency', 'UGX', 'transaction_date', v_now
        )
      ),
      'advance_registration_fee:' || p_request_id::text, false
    );
  END IF;
  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('funds_added', v_req.agent_id, 'agent_advance_requests', p_request_id,
    jsonb_build_object('request_id', p_request_id, 'advance_id', v_advance_id,
                       'principal', v_principal, 'actor_id', v_actor,
                       'gate_override', v_override,
                       'description', 'Agent advance disbursed to wallet'));
  RETURN jsonb_build_object(
    'advance_id', v_advance_id, 'transaction_group_id', v_group,
    'principal', v_principal, 'cycle_days', v_cycle, 'monthly_rate', v_rate,
    'access_fee', v_access_fee, 'registration_fee', v_reg_fee,
    'total_payable', v_total, 'installment', v_installment,
    'installments', v_installments, 'repayment_frequency', v_freq,
    'gate_override', v_override
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_advance_topup(p_advance_id uuid, p_amount numeric, p_extend_days integer, p_request_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_override_eligibility boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.agent_advances;
  v_elig jsonb;
  v_fee numeric;
  v_new_principal numeric;
  v_new_access_fee numeric;
  v_new_outstanding numeric;
  v_new_cycle integer;
  v_new_expires timestamptz;
  v_period integer;
  v_remaining_installments integer;
  v_installment numeric;
  v_days_elapsed integer;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_is_exec boolean;
  v_topup_id uuid;
  v_group uuid;
  v_now timestamptz := now();
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can do this.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'super_admin') OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised to apply advance top-ups.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_is_exec := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin');
  SELECT * INTO a FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'Advance not found.';
  END IF;
  IF COALESCE(p_extend_days,0) <= 0 THEN
    RAISE EXCEPTION 'Extension days must be greater than zero.';
  END IF;
  -- 2026-11-04 controls: the same top-up twice inside two minutes is refused; a top-up equal to another advance's balance or to
  -- the principal of an advance the agent received in the last 7 days is a transfer (no payout) unless the reason says [NEW MONEY].
  PERFORM public._agent_advance_guard('advance_topup', concat_ws('|', p_advance_id, p_amount));
  PERFORM public._agent_advance_assert_new_money(a.agent_id, p_amount, a.id, p_reason);
  IF p_override_eligibility THEN
    IF NOT v_is_exec THEN
      RAISE EXCEPTION 'Only the CFO, a manager or a super admin can top up outside the standard eligibility rules.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 10 THEN
      RAISE EXCEPTION 'A reason of at least 10 characters is required for this top-up.';
    END IF;
    IF a.status NOT IN ('active','repaying','overdue','paused') THEN
      RAISE EXCEPTION 'Only an open advance can be topped up (current status: %).', a.status;
    END IF;
    IF COALESCE(a.outstanding_balance,0) <= 0 THEN
      RAISE EXCEPTION 'This advance is already fully repaid and cannot be topped up.';
    END IF;
    IF p_amount < 10000 THEN
      RAISE EXCEPTION 'Top-up must be at least UGX 10,000.';
    END IF;
    IF p_amount > COALESCE(a.principal,0) THEN
      RAISE EXCEPTION 'Top-up cannot exceed the current advance principal (UGX %).', COALESCE(a.principal,0);
    END IF;
  ELSE
    v_elig := public.agent_advance_topup_eligibility(a.agent_id);
    IF NOT (v_elig->>'eligible')::boolean THEN
      RAISE EXCEPTION 'Top-up rejected: %', COALESCE(v_elig->>'reason','not eligible');
    END IF;
    IF (v_elig->>'advance_id')::uuid <> a.id THEN
      RAISE EXCEPTION 'Top-up target is not the agent''s current ongoing advance.';
    END IF;
    IF p_amount < (v_elig->>'min_topup')::numeric OR p_amount > (v_elig->>'max_topup')::numeric THEN
      RAISE EXCEPTION 'Top-up amount must be between UGX % and UGX %.',
        (v_elig->>'min_topup'), (v_elig->>'max_topup');
    END IF;
  END IF;
  v_fee := round(p_amount * (power(1 + COALESCE(a.monthly_rate, 0.33), p_extend_days::numeric / 30) - 1));
  v_new_principal   := COALESCE(a.principal,0) + p_amount;
  v_new_access_fee  := COALESCE(a.access_fee,0) + v_fee;
  v_new_outstanding := COALESCE(a.outstanding_balance,0) + p_amount + v_fee;
  v_new_cycle       := COALESCE(a.cycle_days,30) + p_extend_days;
  v_new_expires     := GREATEST(a.expires_at, now()) + make_interval(days => p_extend_days);
  v_period := public.advance_period_days(a.repayment_frequency);
  v_days_elapsed := GREATEST(0, ((now() AT TIME ZONE 'Africa/Kampala')::date
                                 - (a.issued_at AT TIME ZONE 'Africa/Kampala')::date));
  v_remaining_installments := GREATEST(
    1,
    ceil(GREATEST(1, v_new_cycle - v_days_elapsed)::numeric / v_period)
  );
  v_installment := ceil(v_new_outstanding / v_remaining_installments);
  PERFORM set_config('app.advance_topup_in_progress', a.id::text, true);
  UPDATE public.agent_advances
  SET principal = v_new_principal,
      access_fee = v_new_access_fee,
      outstanding_balance = v_new_outstanding,
      cycle_days = v_new_cycle,
      expires_at = v_new_expires,
      installment_amount = v_installment,
      daily_installment = CASE WHEN a.repayment_frequency = 'daily' THEN v_installment ELSE a.daily_installment END,
      status = 'active',
      updated_at = now()
  WHERE id = a.id;
  INSERT INTO public.agent_advance_topups (advance_id, amount, topped_up_by, extend_days, request_id, access_fee_added, reason)
  VALUES (a.id, p_amount, COALESCE(auth.uid(), a.issued_by), p_extend_days, p_request_id, v_fee, v_reason)
  RETURNING id INTO v_topup_id;
  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', a.agent_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'amount', p_amount, 'category', 'agent_advance_credit',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'agent_advance_topups', 'source_id', v_topup_id,
        'description', 'Agent advance top-up - extended ' || p_extend_days || 'd',
        'currency', 'UGX', 'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
        'amount', p_amount, 'category', 'agent_advance_disbursement',
        'source_table', 'agent_advances', 'source_id', a.id,
        'description', 'Agent advance top-up disbursed to wallet',
        'currency', 'UGX', 'transaction_date', v_now
      )
    ),
    'advance_topup:' || v_topup_id::text,
    false
  );
  IF v_fee > 0 THEN
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_out',
          'amount', v_fee, 'category', 'agent_advance_access_fee_charged',
          'source_table', 'agent_advances', 'source_id', a.id,
          'description', 'Agent Advance access fee charged on top-up',
          'currency', 'UGX', 'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', a.agent_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_fee, 'category', 'agent_advance_fee_revenue',
          'source_table', 'agent_advances', 'source_id', a.id,
          'description', 'Agent Advance access fee revenue (top-up)',
          'currency', 'UGX', 'transaction_date', v_now
        )
      ),
      'advance_topup_fee:' || v_topup_id::text,
      false
    );
  END IF;
  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('funds_added', a.agent_id, 'agent_advances', a.id,
    jsonb_build_object('topup_id', v_topup_id, 'advance_id', a.id, 'amount', p_amount,
                       'extend_days', p_extend_days, 'reason', v_reason,
                       'override', p_override_eligibility, 'actor_id', auth.uid(),
                       'description', 'Agent advance top-up'));
  IF p_override_eligibility AND auth.uid() IS NOT NULL THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'advance_topup_override', 'agent_advances', a.id::text, v_reason,
      jsonb_build_object('topup_id', v_topup_id, 'amount', p_amount, 'extend_days', p_extend_days,
                         'access_fee_added', v_fee, 'new_principal', v_new_principal,
                         'new_outstanding', v_new_outstanding, 'transaction_group_id', v_group));
  END IF;
  RETURN jsonb_build_object(
    'advance_id', a.id,
    'topup_id', v_topup_id,
    'transaction_group_id', v_group,
    'agent_id', a.agent_id,
    'topup_amount', p_amount,
    'access_fee_added', v_fee,
    'new_principal', v_new_principal,
    'new_outstanding', v_new_outstanding,
    'new_cycle_days', v_new_cycle,
    'new_expires_at', v_new_expires,
    'new_installment', v_installment,
    'repayment_frequency', a.repayment_frequency,
    'monthly_rate', a.monthly_rate,
    'reason', v_reason,
    'override', p_override_eligibility
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_record_advance_payment(p_advance_id uuid, p_amount numeric, p_payment_method text, p_reference text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_adv            RECORD;
  v_today          date;
  v_opening        numeric;
  v_paid           numeric;
  v_closing        numeric;
  v_new_status     text;
  v_total_payable  numeric;
  v_total_deducted numeric;
  v_fee_ratio      numeric;
  v_new_fee        numeric;
  v_fee_status     text;
  v_group_id       uuid;
  v_idem           text;
  v_description    text;
  v_entries        jsonb;
  v_recv_category  text;
  v_alloc          jsonb;
  v_funding        jsonb;
BEGIN
  -- 2026-11-04 controls: the same payment (advance, amount, method, reference) twice inside two minutes is refused
  PERFORM public._agent_advance_guard('advance_payment', concat_ws('|', p_advance_id, p_amount, p_payment_method, COALESCE(p_reference, '')));
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_act_pinned_finance_action(v_caller) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can record advance payments'
      USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A positive amount is required' USING ERRCODE = '22023';
  END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) = 0 THEN
    RAISE EXCEPTION 'A payment reference is required' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method IS NULL OR length(trim(p_payment_method)) = 0 THEN
    RAISE EXCEPTION 'A payment method is required' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method NOT IN ('wallet_offset', 'mobile_money', 'bank_transfer', 'cash') THEN
    RAISE EXCEPTION
      'Unsupported payment_method %. Supported: wallet_offset, mobile_money, bank_transfer, cash. The payment has NOT been recorded.', p_payment_method
      USING ERRCODE = '0A000';
  END IF;
  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_adv.status = 'completed' THEN
    RAISE EXCEPTION 'Advance already completed' USING ERRCODE = '22023';
  END IF;
  IF v_adv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Advance already cancelled' USING ERRCODE = '22023';
  END IF;
  v_today   := (now() AT TIME ZONE 'UTC')::date;
  v_opening := COALESCE(v_adv.outstanding_balance, 0);
  v_paid    := LEAST(p_amount, v_opening);
  v_closing := GREATEST(0, v_opening - v_paid);
  IF v_paid <= 0 THEN
    RAISE EXCEPTION 'Nothing to collect: outstanding balance is %', v_opening
      USING ERRCODE = '22023';
  END IF;
  v_new_status := CASE
    WHEN v_closing <= 0 THEN 'completed'
    WHEN v_adv.expires_at < now() THEN 'overdue'
    ELSE 'active'
  END;
  v_total_payable  := COALESCE(v_adv.principal, 0) + COALESCE(v_adv.access_fee, 0);
  v_total_deducted := v_total_payable - v_closing;
  v_fee_ratio      := CASE
    WHEN v_total_payable > 0
      THEN GREATEST(0, LEAST(1, v_total_deducted / v_total_payable))
    ELSE 0
  END;
  v_new_fee    := round(COALESCE(v_adv.access_fee, 0) * v_fee_ratio);
  v_fee_status := CASE
    WHEN v_new_fee >= COALESCE(v_adv.access_fee, 0) THEN 'settled'
    WHEN v_new_fee > 0 THEN 'partial'
    ELSE 'unpaid'
  END;
  v_idem := 'cfo_adv_pay_' || p_advance_id::text || '_'
            || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
  v_description := 'CFO-recorded advance payment - ref ' || trim(p_reference)
                   || ' - ' || p_payment_method
                   || COALESCE(' - ' || nullif(trim(p_notes), ''), '');
  IF p_payment_method = 'wallet_offset' THEN
    v_funding := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'wallet',
        'direction', 'cash_out', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'user',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ));
    v_alloc := public.agent_advance_allocation_entries(
                 p_advance_id, v_adv.agent_id, v_paid, v_today::timestamptz, false);
    IF v_alloc IS NULL THEN
      v_entries := v_funding || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_in', 'amount', v_paid,
        'category', 'agent_repayment', 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ));
    ELSE
      v_entries := v_funding || v_alloc;
    END IF;
  ELSE
    v_recv_category := CASE
      WHEN p_payment_method = 'cash' THEN 'cash_receipt_in_transit'
      ELSE 'agent_advance_receipt_bank'
    END;
    v_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_in', 'amount', v_paid,
        'category', v_recv_category, 'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      ),
      jsonb_build_object(
        'user_id', v_adv.agent_id, 'ledger_scope', 'platform',
        'direction', 'cash_out', 'amount', v_paid,
        'category', 'agent_advance_repayment_external',
        'recipient_type', 'operational_wallet',
        'source_table', 'agent_advances', 'source_id', p_advance_id,
        'description', v_description, 'currency', 'UGX',
        'transaction_date', v_today
      )
    );
  END IF;
  SELECT public.create_ledger_transaction(
    entries         => v_entries,
    idempotency_key => v_idem
  ) INTO v_group_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'Ledger posting returned no transaction group; aborting'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status, recovery_source, ledger_group_id, note)
  VALUES
    (p_advance_id, v_today, v_opening, 0, v_paid, v_closing,
     CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END,
     CASE WHEN p_payment_method = 'wallet_offset' THEN 'wallet_offset'
          ELSE 'external_' || coalesce(nullif(p_payment_method, ''), 'bank') END,
     CASE WHEN p_payment_method = 'wallet_offset' THEN NULL ELSE v_group_id END,
     left('CFO recorded payment, ref ' || coalesce(nullif(trim(p_reference), ''), '(none)')
          || coalesce(' - ' || nullif(trim(p_notes), ''), ''), 500));
  UPDATE public.agent_advances SET
    outstanding_balance  = v_closing,
    status               = v_new_status,
    access_fee_collected = v_new_fee,
    access_fee_status    = v_fee_status,
    updated_at           = now()
  WHERE id = p_advance_id;
  INSERT INTO public.audit_logs
    (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    'cfo_advance_payment_recorded',
    'agent_advances',
    p_advance_id,
    left(COALESCE(nullif(trim(p_notes), ''), 'manual payment ' || trim(p_reference)), 200),
    jsonb_build_object(
      'amount',               v_paid,
      'payment_method',       p_payment_method,
      'reference',            trim(p_reference),
      'opening_balance',      v_opening,
      'closing_balance',      v_closing,
      'new_status',           v_new_status,
      'transaction_group_id', v_group_id,
      'receiving_account',    CASE
                                WHEN p_payment_method = 'wallet_offset' THEN 'L1'
                                WHEN p_payment_method = 'cash' THEN 'A5'
                                ELSE 'A1' END,
      'posted_atomically',    true
    )
  );
  RETURN jsonb_build_object(
    'success',              true,
    'amount',               v_paid,
    'payment_method',       p_payment_method,
    'opening_balance',      v_opening,
    'closing_balance',      v_closing,
    'new_status',           v_new_status,
    'transaction_group_id', v_group_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_totals(p_from date, p_to date)
 RETURNS TABLE(category_key text, category_label text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH cm AS MATERIALIZED (
    SELECT x.c, CASE WHEN x.c = 'agent_advance_disbursement' THEN 'agent' ELSE public._cfo_paid_category_for(x.c) END AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out' AND g0.transaction_date >= v_from AND g0.transaction_date < v_to) x
  ), legs AS (
    SELECT CASE WHEN g.classification = 'admin_correction' OR (g.category = 'payroll_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE '%lunch allowance%') THEN 'operational'
                WHEN g.ledger_scope = 'platform' AND g.reference_id IN (
                  SELECT sr.wallet_transaction_id::text FROM public.staff_requisitions sr WHERE sr.wallet_credit_status = 'credited' AND sr.wallet_transaction_id IS NOT NULL AND lower(btrim(sr.department_key)) = 'marketing'
                  UNION ALL
                  SELECT er.wallet_transaction_id::text FROM public.employee_requisitions er WHERE er.wallet_credit_status = 'credited' AND er.wallet_transaction_id IS NOT NULL AND lower(btrim(er.department)) IN ('marketing','marketing department')) THEN 'marketing'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Marketing expense: Promissory partner top-up commission%'
                          OR g.description LIKE 'Marketing expense: Promissory partner portfolio commission%'
                          OR g.description LIKE 'Marketing expense: Verified promissory note bonus%'
                          OR g.description = 'Marketing expense: lead partner growth override'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio activation commission%'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio top-up commission%'
                          OR g.description LIKE 'Marketing expense: Partner first fund-in commission%'
                          OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Platform expense: instant house-listed reward%'
                          OR g.description LIKE 'Platform expense: listing reward%'
                          OR g.description LIKE '%recruiter override%'
                          OR g.description LIKE 'Marketing expense: Bonus:%'
                          OR g.description LIKE '%verified bonus%'
                          OR g.description LIKE '%verification bonus%'
                          OR g.description LIKE 'Marketing expense: listing bonus%'
                          OR g.description LIKE '%registration bonus%'
                          OR g.description LIKE '%registration verification bo%'
                          OR g.description LIKE 'Platform expense: instant LC%-registration reward%'
                          OR g.description LIKE 'Marketing expense: Weekly Collection Streak reward%'
                          OR g.description LIKE '%agent commission for landlord payout%'
                          OR g.description LIKE 'Commission restore offset%'
                          OR g.description LIKE 'Marketing expense: commission correction%'
                          OR g.description LIKE 'Marketing expense: agent commission backfill%'
                          OR g.description LIKE 'Marketing expense: Manager agent commission%'
                          OR g.description LIKE 'Marketing expense: Sub-agent tenant reward%'
                          OR g.description LIKE 'Merchant Agent Referral Bonus%'
                          OR (g.description LIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))
                          OR (g.description LIKE 'Marketing expense: Invite reward%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Agent advance%disbursed to wallet%' THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Partner self-managed funding released to agent landlord float%' THEN 'partner'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Undo of double-reversal:%' THEN 'corrections'
                ELSE CASE WHEN cm.k = 'budget' THEN 'operational' ELSE cm.k END END AS cat_key, g.amount
    FROM public.general_ledger g
    LEFT JOIN cm ON cm.c = g.category
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)))
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND g.category <> 'listing_rejection_recovery'
      AND left(COALESCE(g.idempotency_key, ''), 13) <> 'adv_writeoff:' -- 2026-11-04: approved advance write-off (no money paid)
  ), grand AS (SELECT coalesce(sum(l2.amount),0)::numeric AS total FROM legs l2)
  SELECT f.category_key, f.category_label, f.sort_order,
         coalesce(l.amount, 0)::numeric AS amount,
         coalesce(l.tx_count, 0)::bigint AS tx_count,
         CASE WHEN gr.total > 0 THEN round(coalesce(l.amount,0) * 100.0 / gr.total, 2) ELSE 0 END AS pct
  FROM (VALUES
    ('agent', 'Agent Products and Services', 2),
    ('landlord', 'Landlord Products and Services', 3),
    ('tenant', 'Tenant Products and Services', 4),
    ('partner', 'Partnership Products and Services', 5),
    ('operational', 'Operational Expenses', 6),
    ('marketing', 'Marketing Expenses', 7),
    ('rnd', 'Product Research & Development', 8),
    ('corrections', 'Corrections', 9)
  ) AS f(category_key, category_label, sort_order)
  LEFT JOIN (SELECT cl.cat_key, sum(cl.amount) AS amount, count(*) AS tx_count FROM legs cl WHERE cl.cat_key IS NOT NULL GROUP BY cl.cat_key) l
    ON l.cat_key = f.category_key
  CROSS JOIN grand gr
  ORDER BY f.sort_order;
END
$function$;

CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz; v_to timestamptz;
  v_search text := nullif(btrim(p_search), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH cm AS MATERIALIZED (
    SELECT x.c, CASE WHEN x.c = 'agent_advance_disbursement' THEN 'agent' ELSE public._cfo_paid_category_for(x.c) END AS k
    FROM (SELECT DISTINCT g0.category AS c FROM public.general_ledger g0
          WHERE g0.direction = 'cash_out' AND g0.transaction_date >= v_from AND g0.transaction_date < v_to) x
  ), f AS (
    SELECT g.id AS gid, g.transaction_date AS tdate,
           CASE WHEN g.classification = 'admin_correction' OR (g.category = 'payroll_expense' AND g.ledger_scope = 'platform' AND g.description ILIKE '%lunch allowance%') THEN 'operational'
                WHEN g.ledger_scope = 'platform' AND g.reference_id IN (
                  SELECT sr.wallet_transaction_id::text FROM public.staff_requisitions sr WHERE sr.wallet_credit_status = 'credited' AND sr.wallet_transaction_id IS NOT NULL AND lower(btrim(sr.department_key)) = 'marketing'
                  UNION ALL
                  SELECT er.wallet_transaction_id::text FROM public.employee_requisitions er WHERE er.wallet_credit_status = 'credited' AND er.wallet_transaction_id IS NOT NULL AND lower(btrim(er.department)) IN ('marketing','marketing department')) THEN 'marketing'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Marketing expense: Promissory partner top-up commission%'
                          OR g.description LIKE 'Marketing expense: Promissory partner portfolio commission%'
                          OR g.description LIKE 'Marketing expense: Verified promissory note bonus%'
                          OR g.description = 'Marketing expense: lead partner growth override'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio activation commission%'
                          OR g.description LIKE 'Marketing expense: Managed proxy portfolio top-up commission%'
                          OR g.description LIKE 'Marketing expense: Partner first fund-in commission%'
                          OR g.description LIKE 'Marketing expense: Partner repeat fund-in commission%') THEN 'partner'
                WHEN g.category = 'marketing_expense' AND g.ledger_scope = 'platform'
                     AND (g.description LIKE 'Platform expense: instant house-listed reward%'
                          OR g.description LIKE 'Platform expense: listing reward%'
                          OR g.description LIKE '%recruiter override%'
                          OR g.description LIKE 'Marketing expense: Bonus:%'
                          OR g.description LIKE '%verified bonus%'
                          OR g.description LIKE '%verification bonus%'
                          OR g.description LIKE 'Marketing expense: listing bonus%'
                          OR g.description LIKE '%registration bonus%'
                          OR g.description LIKE '%registration verification bo%'
                          OR g.description LIKE 'Platform expense: instant LC%-registration reward%'
                          OR g.description LIKE 'Marketing expense: Weekly Collection Streak reward%'
                          OR g.description LIKE '%agent commission for landlord payout%'
                          OR g.description LIKE 'Commission restore offset%'
                          OR g.description LIKE 'Marketing expense: commission correction%'
                          OR g.description LIKE 'Marketing expense: agent commission backfill%'
                          OR g.description LIKE 'Marketing expense: Manager agent commission%'
                          OR g.description LIKE 'Marketing expense: Sub-agent tenant reward%'
                          OR g.description LIKE 'Merchant Agent Referral Bonus%'
                          OR (g.description LIKE 'Referral%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))
                          OR (g.description LIKE 'Marketing expense: Invite reward%'
                              AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = g.user_id AND ur.role = 'agent'))) THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Agent advance%disbursed to wallet%' THEN 'agent'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Partner self-managed funding released to agent landlord float%' THEN 'partner'
                WHEN g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
                     AND g.description LIKE 'Undo of double-reversal:%' THEN 'corrections'
                ELSE CASE WHEN cm.k = 'budget' THEN 'operational' ELSE cm.k END END AS ckey
    FROM public.general_ledger g
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    LEFT JOIN cm ON cm.c = g.category
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)))
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND g.category <> 'listing_rejection_recovery'
      AND left(COALESCE(g.idempotency_key, ''), 13) <> 'adv_writeoff:' -- 2026-11-04: approved advance write-off (no money paid)
      AND (v_search IS NULL OR g.description ILIKE '%' || v_search || '%'
           OR g.reference_id ILIKE '%' || v_search || '%'
           OR sp.full_name ILIKE '%' || v_search || '%')
  ), pg AS (
    SELECT f.gid, f.tdate, f.ckey, count(*) OVER () AS n
    FROM f
    WHERE (p_category IS NULL OR f.ckey = p_category)
    ORDER BY f.tdate DESC, f.gid
    OFFSET p_offset LIMIT p_limit
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'agent' THEN 'Agent Products and Services'
                      WHEN 'landlord' THEN 'Landlord Products and Services'
                      WHEN 'tenant' THEN 'Tenant Products and Services'
                      WHEN 'partner' THEN 'Partnership Products and Services'
                      WHEN 'marketing' THEN 'Marketing Expenses'
                      WHEN 'operational' THEN 'Operational Expenses'
                      WHEN 'budget' THEN 'Budget Expenses'
                      WHEN 'rnd' THEN 'Product Research & Development'
                      WHEN 'corrections' THEN 'Corrections'
                      ELSE pg.ckey END,
         g.category, g.amount, g.description, g.reference_id,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN cp.full_name ELSE p.full_name END,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN cp.phone ELSE p.phone END,
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_in' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END
$function$;
