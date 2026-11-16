-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Self-support option 2: the partner pays the landlord directly. Phase 1: tables and money map.
--
-- Nothing here moves money or changes a live flow. The switch self_support_direct_pay
-- is created OFF. Plan: https://claude.ai/artifact/C3ihdjpASTDLXwGnLrCsYs ("Implementation phases").
--
--   1. funder_offplatform_rent_payments (Benjamin, 2026-11-11, 0 rows) gains the direct-pay columns: flow,
--      the 48-hour hold, landlord snapshot, flags, landlord OTP, call note, and links to the portfolio, ledger
--      groups and WLR receipt. Old rows keep flow = 'legacy' and behave exactly as before.
--   2. funder_offplatform_rent_proofs: one row per SMS screenshot (450,000 + 50,000 = two rows). A TID can be
--      APPROVED once (unique index); duplicates at submit are flagged, not refused.
--   3. Normalised-TID indexes (normalize_momo_tid = digits only) where the "TID used before" flag looks.
--      All five tables are small (largest 31 MB), so plain CREATE INDEX inside the transaction.
--   4. Ledger: welile_cover_fee from the partner's operational FLOAT maps to L1 (wallet custody). Without this
--      row the float leg falls back to A2 (cash with agents) and the group fails the mapped-balance check.
--   5. Ledger: new category partner_direct_rent_capital (platform, L2): the partner's capital when the rent
--      never passed through Welile. Mapped and allowlisted together.
--   The only function replaced is ledger_category_allowlist() (append-only, same pattern as 20261113170000).
--
-- Re-runnable: every step is IF NOT EXISTS / drop-then-add / insert-where-missing.
-- Rollback: supabase/rollbacks/20261121090000_direct_pay_phase1_tables.rollback.sql
-- REQUIRES THE OWNER'S YES before it is applied to production.

SET lock_timeout = '5s';

-- ---------------------------------------------------------------- 0. guards
DO $guard$
BEGIN
  IF to_regclass('public.funder_offplatform_rent_payments') IS NULL THEN
    RAISE EXCEPTION 'direct pay phase 1: funder_offplatform_rent_payments is missing (20261113160000 not applied)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'funder_offplatform_rent_payments'
                    AND column_name = 'cover_fee_status') THEN
    RAISE EXCEPTION 'direct pay phase 1: the cover fee columns are missing (20261113170000 not applied)';
  END IF;
  IF to_regprocedure('public.normalize_momo_tid(text)') IS NULL THEN
    RAISE EXCEPTION 'direct pay phase 1: normalize_momo_tid(text) is missing';
  END IF;
  IF NOT ('welile_cover_fee' = ANY (public.ledger_category_allowlist())) THEN
    RAISE EXCEPTION 'direct pay phase 1: welile_cover_fee is not on the ledger allowlist';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------- 1. switch (OFF)
INSERT INTO public.pipeline_switches (key, is_on, note)
SELECT 'self_support_direct_pay', false,
       'Option 2: the partner pays the landlord directly (SMS proof, Landlord Ops call + landlord OTP). See 20261121090000.'
 WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_switches WHERE key = 'self_support_direct_pay');

-- ---------------------------------------------------------------- 2. payments: direct-pay columns
ALTER TABLE public.funder_offplatform_rent_payments
  ADD COLUMN IF NOT EXISTS flow                       text        NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS hold_started_at            timestamptz,
  ADD COLUMN IF NOT EXISTS hold_expires_at            timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS landlord_id                uuid,
  ADD COLUMN IF NOT EXISTS landlord_phone             text,
  ADD COLUMN IF NOT EXISTS agent_id                   uuid,
  ADD COLUMN IF NOT EXISTS amount_received            numeric     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flags                      text[]      NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS flag_reason                text,
  ADD COLUMN IF NOT EXISTS call_note                  text,
  ADD COLUMN IF NOT EXISTS landlord_otp_challenge_id  uuid,
  ADD COLUMN IF NOT EXISTS landlord_otp_verified_at   timestamptz,
  ADD COLUMN IF NOT EXISTS portfolio_id               uuid,
  ADD COLUMN IF NOT EXISTS ledger_group_id            uuid,
  ADD COLUMN IF NOT EXISTS agent_pay_ledger_group_id  uuid,
  ADD COLUMN IF NOT EXISTS receipt_id                 uuid,
  ADD COLUMN IF NOT EXISTS reminders_sent             smallint    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_at           timestamptz,
  ADD COLUMN IF NOT EXISTS coo_marked_at              timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at                 timestamptz NOT NULL DEFAULT now();

-- held -> pending (proofs reach the Rent Plan amount, waiting for Landlord Ops) -> confirmed | rejected;
-- held -> expired (48 hours, no complete proof). Legacy rows only ever use pending / confirmed / rejected.
ALTER TABLE public.funder_offplatform_rent_payments
  DROP CONSTRAINT IF EXISTS funder_offplatform_rent_payments_status_check,
  DROP CONSTRAINT IF EXISTS fopr_flow_check,
  DROP CONSTRAINT IF EXISTS fopr_amount_received_check,
  DROP CONSTRAINT IF EXISTS fopr_reminders_check,
  DROP CONSTRAINT IF EXISTS fopr_direct_pay_shape,
  DROP CONSTRAINT IF EXISTS fopr_direct_pay_approval_proof,
  DROP CONSTRAINT IF EXISTS fopr_direct_pay_flag_reason;
ALTER TABLE public.funder_offplatform_rent_payments
  ADD CONSTRAINT funder_offplatform_rent_payments_status_check
    CHECK (status IN ('held', 'pending', 'confirmed', 'rejected', 'expired')),
  ADD CONSTRAINT fopr_flow_check CHECK (flow IN ('legacy', 'direct_pay')),
  ADD CONSTRAINT fopr_amount_received_check CHECK (amount_received >= 0),
  ADD CONSTRAINT fopr_reminders_check CHECK (reminders_sent BETWEEN 0 AND 10),
  -- A direct payment is mobile money with a hold; held / expired are direct-pay states only.
  ADD CONSTRAINT fopr_direct_pay_shape CHECK (
    CASE WHEN flow = 'direct_pay'
         THEN method = 'mobile_money' AND hold_started_at IS NOT NULL AND hold_expires_at > hold_started_at
         ELSE status NOT IN ('held', 'expired') END),
  -- The one rule no screen or RPC can skip: a confirmed direct payment has the landlord's OTP and a call note.
  ADD CONSTRAINT fopr_direct_pay_approval_proof CHECK (
    flow <> 'direct_pay' OR status <> 'confirmed'
    OR (landlord_otp_verified_at IS NOT NULL AND NULLIF(btrim(call_note), '') IS NOT NULL)),
  -- Approving with a red flag needs a written reason.
  ADD CONSTRAINT fopr_direct_pay_flag_reason CHECK (
    flow <> 'direct_pay' OR status <> 'confirmed' OR cardinality(flags) = 0
    OR NULLIF(btrim(flag_reason), '') IS NOT NULL);

-- One live direct payment per Rent Plan: this index is what decides a same-second race between two partners.
CREATE UNIQUE INDEX IF NOT EXISTS ux_fopr_direct_pay_live_plan
  ON public.funder_offplatform_rent_payments (rent_request_id)
  WHERE flow = 'direct_pay' AND status IN ('held', 'pending', 'confirmed');
-- Expiry and reminder job: only held rows, by end time.
CREATE INDEX IF NOT EXISTS ix_fopr_direct_pay_hold_expiry
  ON public.funder_offplatform_rent_payments (hold_expires_at)
  WHERE flow = 'direct_pay' AND status = 'held';
-- Landlord Ops queue, keyset-paged by (created_at, id).
CREATE INDEX IF NOT EXISTS ix_fopr_direct_pay_queue
  ON public.funder_offplatform_rent_payments (created_at, id)
  WHERE flow = 'direct_pay' AND status = 'pending';

DROP TRIGGER IF EXISTS trg_fopr_touch_updated_at ON public.funder_offplatform_rent_payments;
CREATE TRIGGER trg_fopr_touch_updated_at
  BEFORE UPDATE ON public.funder_offplatform_rent_payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON COLUMN public.funder_offplatform_rent_payments.flow IS
  'legacy = the 2026-11-11 record-only flow; direct_pay = option 2 (hold, SMS proofs, Landlord Ops call + landlord OTP).';
COMMENT ON COLUMN public.funder_offplatform_rent_payments.flags IS
  'Suspicion flags set at submit (tid_used_before, paid_before_hold, wrong_number, number_not_read, tids_differ, photo_unreadable, same_photo, paid_more). Shown to Landlord Ops; never auto-approve or auto-reject.';

-- ---------------------------------------------------------------- 3. proofs (one row per SMS)
CREATE TABLE IF NOT EXISTS public.funder_offplatform_rent_proofs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id         uuid        NOT NULL REFERENCES public.funder_offplatform_rent_payments (id) ON DELETE RESTRICT,
  partner_id         uuid        NOT NULL,
  photo_path         text        NOT NULL,
  photo_sha256       text,
  provider           text,
  tid_typed          text,
  tid_read           text,
  tid_norm           text        GENERATED ALWAYS AS
                                   (public.normalize_momo_tid(COALESCE(NULLIF(btrim(tid_typed), ''), tid_read))) STORED,
  amount_read        numeric,
  recipient_read     text,
  paid_at_read       timestamptz,
  reader_status      text        NOT NULL DEFAULT 'pending',
  reader_confidence  numeric,
  status             text        NOT NULL DEFAULT 'submitted',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fop_proofs_photo_owner   CHECK (photo_path LIKE partner_id::text || '/%'),
  CONSTRAINT fop_proofs_provider      CHECK (provider IS NULL OR provider IN ('mtn', 'airtel')),
  CONSTRAINT fop_proofs_amount        CHECK (amount_read IS NULL OR amount_read > 0),
  CONSTRAINT fop_proofs_reader_status CHECK (reader_status IN ('pending', 'read', 'unreadable', 'error')),
  CONSTRAINT fop_proofs_status        CHECK (status IN ('submitted', 'approved', 'rejected'))
);

-- A TID is approved once, ever. At submit a repeat is only flagged, so Landlord Ops still see it.
CREATE UNIQUE INDEX IF NOT EXISTS ux_fop_proofs_tid_approved
  ON public.funder_offplatform_rent_proofs (tid_norm) WHERE status = 'approved' AND tid_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_fop_proofs_tid   ON public.funder_offplatform_rent_proofs (tid_norm) WHERE tid_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_fop_proofs_photo ON public.funder_offplatform_rent_proofs (photo_sha256) WHERE photo_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_fop_proofs_payment ON public.funder_offplatform_rent_proofs (payment_id, created_at);

ALTER TABLE public.funder_offplatform_rent_proofs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_reads_own_offplatform_proofs ON public.funder_offplatform_rent_proofs;
CREATE POLICY partner_reads_own_offplatform_proofs
  ON public.funder_offplatform_rent_proofs FOR SELECT TO authenticated
  USING (partner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.funder_offplatform_rent_proofs;
CREATE POLICY mfa_required_for_staff
  ON public.funder_offplatform_rent_proofs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- Writes go through SECURITY DEFINER RPCs (phases 2 and 3); the browser only reads its own rows.
REVOKE ALL ON public.funder_offplatform_rent_proofs FROM anon, authenticated;
GRANT SELECT ON public.funder_offplatform_rent_proofs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.funder_offplatform_rent_proofs TO service_role;

COMMENT ON TABLE public.funder_offplatform_rent_proofs IS
  'Option 2: one row per SMS screenshot a partner uploads for a direct landlord payment. tid_norm = digits of the typed TID, else the read one.';

-- ---------------------------------------------------------------- 4. normalised-TID lookups for the flags
-- Not partial: normalize_momo_tid is not STRICT, so the planner cannot prove "normalize_momo_tid(x) = $1" implies
-- "x IS NOT NULL" and would never use a partial index. Tested with EXPLAIN in supabase/tests/direct_pay.
CREATE INDEX IF NOT EXISTS ix_deposit_requests_tid_norm
  ON public.deposit_requests (public.normalize_momo_tid(transaction_id));
CREATE INDEX IF NOT EXISTS ix_withdrawal_requests_tid_norm
  ON public.withdrawal_requests (public.normalize_momo_tid(transaction_id));
CREATE INDEX IF NOT EXISTS ix_withdrawal_requests_fin_ops_ref_norm
  ON public.withdrawal_requests (public.normalize_momo_tid(fin_ops_reference));
CREATE INDEX IF NOT EXISTS ix_landlord_payouts_momo_ref_norm
  ON public.landlord_payouts (public.normalize_momo_tid(finops_momo_reference));
CREATE INDEX IF NOT EXISTS ix_landlord_payouts_external_ref_norm
  ON public.landlord_payouts (public.normalize_momo_tid(external_reference));

-- ---------------------------------------------------------------- 5. ledger: Cover fee from operational float
-- wallet / welile_cover_fee / float -> L1, debit on cash_out (the partner's custody balance falls).
-- The withdrawable row (L1) and the platform row (R1, kept when there is no proxy agent) already exist.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
SELECT 'wallet', 'welile_cover_fee', 'float', 'L1', 'cash_out',
       'Option 2: the 2% Cover fee taken from a partner''s operational float at Landlord Ops approval. Partner money (L1), not cash with agents (A2). 20261121090000.'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.ledger_account_map m
    WHERE m.ledger_scope = 'wallet' AND m.category = 'welile_cover_fee'
      AND m.wallet_bucket IS NOT DISTINCT FROM 'float');

-- ---------------------------------------------------------------- 5b. ledger: partner capital with no cash in it
-- At approval Welile owes the partner the Rent Plan amount (L2) and the tenant owes Welile the same (A3).
-- Group: bridge rent_receivable_created cash_in (DR A3, as option 1 posts it) + platform partner_direct_rent_capital
-- cash_out (CR L2). Raw cash_in = cash_out, mapped DR = CR, no wallet leg, no cash account.
-- A new category, not partner_receivable_capital: that one is the promissory-note obligation (7,144 legs) and
-- note reports sum it.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
SELECT 'platform', 'partner_direct_rent_capital', NULL, 'L2', 'cash_in',
       'Option 2: partner capital for a Rent Plan the partner paid to the landlord directly (no cash through Welile). Credit on cash_out. 20261121090000.'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.ledger_account_map m
    WHERE m.ledger_scope = 'platform' AND m.category = 'partner_direct_rent_capital' AND m.wallet_bucket IS NULL);

-- Append to the live allowlist (replacing the whole function would drop categories added after any repo copy).
DO $allow$
DECLARE
  v_src text;
  v_expr text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  IF v_src ILIKE '%partner_direct_rent_capital%' THEN
    RETURN;
  END IF;
  v_expr := regexp_replace(regexp_replace(v_src, '^\s*select\s+', '', 'i'), ';\s*$', '');
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
    RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_temp' AS $body$
  SELECT (%s) || ARRAY['partner_direct_rent_capital']::text[];
$body$ $f$, v_expr);
END
$allow$;

-- ---------------------------------------------------------------- 6. post-checks
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map
                  WHERE ledger_scope = 'wallet' AND category = 'welile_cover_fee'
                    AND wallet_bucket = 'float' AND account_code = 'L1' AND debit_when = 'cash_out') THEN
    RAISE EXCEPTION 'direct pay phase 1: the float mapping row for welile_cover_fee is missing or different';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map
                  WHERE ledger_scope = 'platform' AND category = 'partner_direct_rent_capital'
                    AND wallet_bucket IS NULL AND account_code = 'L2' AND debit_when = 'cash_in')
     OR NOT ('partner_direct_rent_capital' = ANY (public.ledger_category_allowlist())) THEN
    RAISE EXCEPTION 'direct pay phase 1: partner_direct_rent_capital is not both mapped (L2) and allowlisted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND NOT has_table_privilege('authenticated', 'public.funder_offplatform_rent_proofs', 'SELECT') THEN
    RAISE EXCEPTION 'direct pay phase 1: authenticated cannot read funder_offplatform_rent_proofs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_table_privilege('authenticated', 'public.funder_offplatform_rent_proofs', 'INSERT') THEN
    RAISE EXCEPTION 'direct pay phase 1: authenticated must not write funder_offplatform_rent_proofs directly';
  END IF;
  IF (SELECT is_on FROM public.pipeline_switches WHERE key = 'self_support_direct_pay') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'direct pay phase 1: the switch must exist and be OFF';
  END IF;
END
$check$;
