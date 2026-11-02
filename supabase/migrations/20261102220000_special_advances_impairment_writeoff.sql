-- 2026-11-02: Special Advances readiness, Phase C: impairment, write-off and recovery. Production apply needs explicit
-- CFO approval. Requires Phase B (20261102210000) first. Changes the accounting policy: new account A25, six mapping
-- rows, six allowlisted categories. Changes no existing account, mapping row, category or posting.
--
-- CFO decisions (2026-11-02):
--   D7  impairment minimum by days past due (oldest unpaid instalment past its due date): current 0%, 1-30 days 10%,
--       31-60 days 25%, 61-90 days 50%, over 90 days 100%. The CFO may set a HIGHER individual rate per advance
--       (never lower); it carries forward to later reviews until changed (0 = back to the minimum).
--   D8  A24 stays the gross receivable. New contra-asset A25 'Special Advances — Impairment Allowance' (credit
--       balance); the expense goes to the existing X4 'Credit Losses and Write-offs', identifiable by category.
--   Provisions: a CFO runs a review (the server computes every paid-out advance's required allowance on its gross
--       outstanding and proposes the difference); a DIFFERENT CFO approves before anything posts. On approval the
--       figures are recomputed and the review is refused as stale if anything moved.
--   D9  write-off: reason (20-1000 characters) + archived evidence file; a different CFO approves. The whole gross
--       outstanding (principal + unpaid fees) is written off; past revenue (R1) is left as reported. The advance ends
--       'written_off' (terminal); its history stays.
--   D10 money recovered after a write-off: DR A1 / CR X4, recorded by a CFO with reference + proof; the advance stays
--       written off; recoveries never exceed what was written off.
-- Safety default (flagged to the CFO, not a recorded decision): a borrower with a written-off Special Advance is not
-- eligible for a new one (WRITTEN_OFF_SPECIAL_ADVANCE), like the existing overdue / defaulted checks.
--
-- Ledger (create_ledger_transaction; one fixed key per posting):
--   provision raise  d: special_advance_impairment_charge    cash_out d -> DR X4
--                       special_advance_impairment_allowance cash_in  d -> CR A25
--   provision release d: the same two categories, directions swapped -> DR A25 / CR X4
--   write-off of gross G with allowance H held:
--                       special_advance_impairment_allowance cash_out H -> DR A25 (all of it)
--                       special_advance_write_off            cash_in  G -> CR A24
--                       G > H: special_advance_write_off_loss     cash_out G-H -> DR X4
--                       H > G: special_advance_impairment_charge  cash_in  H-G -> CR X4 (excess allowance released)
--   recovery R:         special_advance_recovery_received    cash_in  R -> DR A1
--                       special_advance_recovery_income      cash_out R -> CR X4
--   Every group nets to zero raw and balances on base mapping; all legs are platform scope (no wallet moves).
--
-- Replaces (preflight pins each to its Phase B / production md5): _special_advance_guard_update, _special_advance_audit,
-- _special_advance_check_proof, _special_advance_eligibility, special_advance_statement, special_advance_reconciliation,
-- and extends ledger_category_allowlist() in place (pinned md5 f61da259…, search_path kept).
-- Rollback: supabase/rollbacks/20261102220000_special_advances_impairment_writeoff.rollback.sql (refuses once used).
-- Tests: src/test/specialAdvanceImpairment.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.special_advance_corrections') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances Phase B (20261102210000) is not applied; nothing was changed';
  END IF;
  IF to_regclass('public.special_advance_write_offs') IS NOT NULL OR to_regclass('public.special_advance_provision_reviews') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances impairment objects already exist; nothing was changed';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public._special_advance_guard_update()', '905973f98fe6440d21fd2edaa4591182'),
      ('public._special_advance_audit()', 'c0cc409f070905a07ff19504b0f196ac'),
      ('public._special_advance_check_proof(uuid,text)', 'd12aa37dc682ebe7f64b376e2255e263'),
      ('public.special_advance_statement(uuid)', 'e46ad4cc6e46cf0ea723c705db429947'),
      ('public.special_advance_reconciliation()', '538f7ed60a247b1b7f2eda3d25dd5da7'),
      ('public._special_advance_eligibility(text,uuid,text,text,text,uuid)', 'c5d49dfa28e9c6fa5cf1c270a8547cb0'),
      ('public._special_advance_position(uuid)', 'c17b7e48f943731c5c5f8d29f3c2e9dc')) v(sig, md5)
  LOOP
    IF to_regprocedure(r.sig) IS NULL
       OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'precondition failed: % differs from the Phase B definition; nothing was changed', r.sig;
    END IF;
  END LOOP;
  IF to_regclass('public.ledger_account_catalog') IS NULL OR to_regclass('public.ledger_account_map') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.ledger_account_catalog WHERE code = 'X4' AND nature = 'expense')
     OR NOT EXISTS (SELECT 1 FROM public.ledger_account_catalog WHERE code = 'A24' AND label = 'Special Advances Receivable') THEN
    RAISE EXCEPTION 'precondition failed: account A24 or X4 is not as expected; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_catalog WHERE code = 'A25') THEN
    RAISE EXCEPTION 'precondition failed: account A25 already exists; nothing was changed';
  END IF;
  -- the allowlist must be exactly what Phase 4 left (production read-only check 2026-11-02)
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM 'f61da259fbb92c484402bb3149abac37'
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=public, extensions, pg_temp'] THEN
    RAISE EXCEPTION 'precondition failed: ledger_category_allowlist() differs from the Phase 4 definition; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category IN ('special_advance_impairment_charge', 'special_advance_impairment_allowance',
               'special_advance_write_off', 'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income'))
     OR public.ledger_category_allowlist() && ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance',
               'special_advance_write_off', 'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income'] THEN
    RAISE EXCEPTION 'precondition failed: a Phase C ledger category already exists; nothing was changed';
  END IF;
END
$pre$;

-- ── Chart of accounts, mapping, allowlist ──────────────────────────────────────────────────────────
INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order)
VALUES ('A25', 'Special Advances — Impairment Allowance', 'current_asset', 'asset',
        COALESCE((SELECT sort_order + 1 FROM public.ledger_account_catalog WHERE code = 'A24'), 125));

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform', 'special_advance_impairment_charge', NULL, 'X4', 'cash_out', 'Special Advance impairment: raise (DR X4) or release (CR X4)'),
  ('platform', 'special_advance_impairment_allowance', NULL, 'A25', 'cash_out', 'Special Advance impairment allowance (contra A24): raise CR, release / use DR'),
  ('platform', 'special_advance_write_off', NULL, 'A24', 'cash_out', 'Special Advance written off: the gross receivable leaves A24 (CR)'),
  ('platform', 'special_advance_write_off_loss', NULL, 'X4', 'cash_out', 'Special Advance write-off not covered by the allowance (DR X4)'),
  ('platform', 'special_advance_recovery_received', NULL, 'A1', 'cash_in', 'Money recovered on a written-off Special Advance into company cash (DR A1)'),
  ('platform', 'special_advance_recovery_income', NULL, 'X4', 'cash_in', 'Recovery after write-off reduces credit losses (CR X4)');

DO $allow$
DECLARE
  v_before text[] := public.ledger_category_allowlist();
  v_src text;
  v_expr text;
  v_after text[];
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  v_expr := regexp_replace(regexp_replace(v_src, '^\s*select\s+', '', 'i'), ';\s*$', '');
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
    RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_temp' AS $body$
  SELECT (%s) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[];
$body$$f$, v_expr);
  v_after := public.ledger_category_allowlist();
  IF NOT (v_after @> v_before)
     OR cardinality(v_after) <> cardinality(v_before) + 6
     OR NOT (v_after @> ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                              'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']) THEN
    RAISE EXCEPTION 'allowlist check failed: previous categories not all preserved, or new ones missing';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=public, extensions, pg_temp']
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'allowlist check failed: the search_path setting or volatility was not preserved';
  END IF;
END
$allow$;

-- ── Status and event values ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.special_advances
  DROP CONSTRAINT special_advances_status_check,
  ADD CONSTRAINT special_advances_status_check
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled', 'reversed', 'written_off')),
  DROP CONSTRAINT special_advances_approved_fields,
  ADD CONSTRAINT special_advances_approved_fields CHECK (
    status NOT IN ('approved', 'disbursed', 'settled', 'reversed', 'written_off') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  DROP CONSTRAINT special_advances_disbursed_fields,
  ADD CONSTRAINT special_advances_disbursed_fields CHECK (
    status NOT IN ('disbursed', 'settled', 'reversed', 'written_off') OR (payout_date IS NOT NULL AND disbursed_by IS NOT NULL AND disbursed_at IS NOT NULL)),
  DROP CONSTRAINT special_advances_payout_record,
  ADD CONSTRAINT special_advances_payout_record CHECK (
    status NOT IN ('disbursed', 'settled', 'reversed', 'written_off')
    OR (payout_method IS NOT NULL AND payout_ledger_group_id IS NOT NULL
        AND (payout_method = 'wallet') = (borrower_kind = 'welile_user')
        AND (payout_method = 'wallet' OR (payout_reference IS NOT NULL AND payout_proof_path IS NOT NULL))
        AND (payout_method <> 'wallet' OR payout_proof_path IS NULL)));

ALTER TABLE public.special_advance_events
  DROP CONSTRAINT special_advance_events_event_type_check,
  ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type IN (
    'created', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled', 'reopened', 'reversed',
    'correction_requested', 'correction_approved', 'correction_rejected', 'correction_withdrawn',
    'written_off', 'write_off_requested', 'write_off_approved', 'write_off_rejected', 'write_off_withdrawn',
    'provision_posted', 'recovery_recorded'));

-- ── Impairment helpers ─────────────────────────────────────────────────────────────────────────────
-- D7 minimum rate (percent) for a number of days past due.
CREATE FUNCTION public._special_advance_minimum_rate(p_days_past_due integer)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN COALESCE(p_days_past_due, 0) <= 0 THEN 0::numeric
              WHEN p_days_past_due <= 30 THEN 10::numeric
              WHEN p_days_past_due <= 60 THEN 25::numeric
              WHEN p_days_past_due <= 90 THEN 50::numeric
              ELSE 100::numeric END;
$$;

-- ── Provision reviews (maker-checker) ──────────────────────────────────────────────────────────────
CREATE SEQUENCE public.special_advance_provision_seq START 1;
CREATE SEQUENCE public.special_advance_write_off_seq START 1;

CREATE TABLE public.special_advance_provision_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^SAP-[0-9]{6,}$'),
  as_of_date date NOT NULL,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 5 AND 1000),
  total_delta bigint NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 5 AND 1000),
  CONSTRAINT special_advance_provision_reviews_decided CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT special_advance_provision_reviews_rejected_note CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  CONSTRAINT special_advance_provision_reviews_maker_checker CHECK (status NOT IN ('approved', 'rejected') OR decided_by <> requested_by),
  CONSTRAINT special_advance_provision_reviews_withdrawn_self CHECK (status <> 'withdrawn' OR decided_by = requested_by)
);
-- one review awaiting a decision at a time
CREATE UNIQUE INDEX special_advance_provision_reviews_one_pending ON public.special_advance_provision_reviews ((true)) WHERE status = 'pending';

CREATE TABLE public.special_advance_provision_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.special_advance_provision_reviews(id),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  gross_outstanding bigint NOT NULL CHECK (gross_outstanding >= 0),
  days_past_due integer NOT NULL CHECK (days_past_due >= 0),
  minimum_rate numeric(5, 2) NOT NULL CHECK (minimum_rate BETWEEN 0 AND 100),
  individual_rate numeric(5, 2) CHECK (individual_rate IS NULL OR individual_rate BETWEEN 0 AND 100),
  applied_rate numeric(5, 2) NOT NULL CHECK (applied_rate BETWEEN 0 AND 100),
  required_allowance bigint NOT NULL CHECK (required_allowance BETWEEN 0 AND gross_outstanding),
  held_before bigint NOT NULL CHECK (held_before >= 0),
  delta bigint NOT NULL,
  ledger_group_id uuid,
  CONSTRAINT special_advance_provision_lines_delta CHECK (delta = required_allowance - held_before),
  CONSTRAINT special_advance_provision_lines_rate CHECK (applied_rate = GREATEST(minimum_rate, COALESCE(individual_rate, 0))),
  UNIQUE (review_id, advance_id)
);
CREATE INDEX special_advance_provision_lines_advance_idx ON public.special_advance_provision_lines (advance_id);

-- ── Write-offs (maker-checker) and recoveries ──────────────────────────────────────────────────────
CREATE TABLE public.special_advance_write_offs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^SAW-[0-9]{6,}$'),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  gross_amount bigint NOT NULL CHECK (gross_amount > 0),
  allowance_released bigint NOT NULL CHECK (allowance_released >= 0),
  net_loss bigint NOT NULL,
  CONSTRAINT special_advance_write_offs_amounts CHECK (net_loss = gross_amount - allowance_released),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 20 AND 1000),
  proof_path text NOT NULL UNIQUE CHECK (proof_path ~ '^advances/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$'),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 5 AND 1000),
  ledger_group_id uuid,
  CONSTRAINT special_advance_write_offs_decided CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT special_advance_write_offs_posted CHECK ((status = 'approved') = (ledger_group_id IS NOT NULL)),
  CONSTRAINT special_advance_write_offs_rejected_note CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  CONSTRAINT special_advance_write_offs_maker_checker CHECK (status NOT IN ('approved', 'rejected') OR decided_by <> requested_by),
  CONSTRAINT special_advance_write_offs_withdrawn_self CHECK (status <> 'withdrawn' OR decided_by = requested_by)
);
CREATE UNIQUE INDEX special_advance_write_offs_one_open ON public.special_advance_write_offs (advance_id) WHERE status IN ('pending', 'approved');

CREATE TABLE public.special_advance_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  amount bigint NOT NULL CHECK (amount > 0),
  received_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('mobile_money', 'bank_transfer')),
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 3 AND 100),
  proof_path text NOT NULL UNIQUE CHECK (proof_path ~ '^advances/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$'),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  ledger_group_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX special_advance_recoveries_reference_uq ON public.special_advance_recoveries (method, upper(btrim(reference)));
CREATE INDEX special_advance_recoveries_advance_idx ON public.special_advance_recoveries (advance_id);

-- Guards: requests start pending and are decided once; posted figures never change; nothing is deleted.
CREATE FUNCTION public._special_advance_guard_decided()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  o jsonb;
  n jsonb;
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
  END IF;
  n := to_jsonb(NEW);
  IF TG_OP = 'INSERT' THEN
    IF n ->> 'status' <> 'pending' OR n ->> 'decided_by' IS NOT NULL OR n ->> 'decided_at' IS NOT NULL
       OR n ->> 'decision_note' IS NOT NULL OR n ->> 'ledger_group_id' IS NOT NULL THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_REQUEST_MUST_START_PENDING' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD);
  IF o ->> 'status' <> 'pending' OR n ->> 'status' = 'pending' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_REQUEST_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  -- only the decision fields may change, in the one decision
  FOREACH k IN ARRAY ARRAY(SELECT jsonb_object_keys(o)) LOOP
    IF k NOT IN ('status', 'decided_by', 'decided_at', 'decision_note', 'ledger_group_id') AND (o -> k) IS DISTINCT FROM (n -> k) THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_REQUEST_IMMUTABLE' USING ERRCODE = '42501', DETAIL = k;
    END IF;
  END LOOP;
  IF n ->> 'status' IN ('approved', 'rejected') AND NOT public._has_enabled_role((n ->> 'decided_by')::uuid, ARRAY['cfo']) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_APPROVER_NOT_CFO' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER special_advance_provision_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON public.special_advance_provision_reviews
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_decided();
CREATE TRIGGER special_advance_write_offs_guard BEFORE INSERT OR UPDATE OR DELETE ON public.special_advance_write_offs
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_decided();

-- Provision lines: written with their review; the ledger group is stamped once, when the review is approved.
CREATE FUNCTION public._special_advance_guard_provision_line()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.ledger_group_id IS NULL AND NEW.ledger_group_id IS NOT NULL AND OLD.delta <> 0
     AND (to_jsonb(NEW) - 'ledger_group_id') = (to_jsonb(OLD) - 'ledger_group_id')
     AND EXISTS (SELECT 1 FROM public.special_advance_provision_reviews v WHERE v.id = OLD.review_id AND v.status = 'approved') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
END $$;
CREATE TRIGGER special_advance_provision_lines_guard BEFORE UPDATE OR DELETE ON public.special_advance_provision_lines
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_provision_line();
CREATE TRIGGER special_advance_recoveries_append_only BEFORE UPDATE OR DELETE ON public.special_advance_recoveries
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();

REVOKE ALL ON public.special_advance_provision_reviews, public.special_advance_provision_lines, public.special_advance_write_offs,
              public.special_advance_recoveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.special_advance_provision_reviews, public.special_advance_provision_lines, public.special_advance_write_offs,
                public.special_advance_recoveries TO authenticated;
GRANT ALL ON public.special_advance_provision_reviews, public.special_advance_provision_lines, public.special_advance_write_offs,
             public.special_advance_recoveries TO service_role;
REVOKE ALL ON SEQUENCE public.special_advance_provision_seq, public.special_advance_write_off_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.special_advance_provision_seq, public.special_advance_write_off_seq TO service_role;
ALTER TABLE public.special_advance_provision_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_provision_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_write_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_recoveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY special_advance_provision_reviews_select ON public.special_advance_provision_reviews FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_provision_lines_select ON public.special_advance_provision_lines FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_write_offs_select ON public.special_advance_write_offs FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_recoveries_select ON public.special_advance_recoveries FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_provision_reviews AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_provision_lines AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_write_offs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_recoveries AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- ── Allowance held and required, per advance ──────────────────────────────────────────────────────
-- Held = approved provision movements - allowance released by an approved write-off (the subledger of A25).
CREATE FUNCTION public._special_advance_allowance_held(p_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (COALESCE((SELECT sum(l.delta) FROM public.special_advance_provision_lines l
                      JOIN public.special_advance_provision_reviews v ON v.id = l.review_id AND v.status = 'approved'
                     WHERE l.advance_id = p_id), 0)
        - COALESCE((SELECT sum(w.allowance_released) FROM public.special_advance_write_offs w
                     WHERE w.advance_id = p_id AND w.status = 'approved'), 0))::bigint;
$$;

-- What the allowance should be for one advance: on the gross outstanding of a paid-out (disbursed) advance, the higher
-- of the D7 minimum and the individual rate (p_individual; NULL = carry forward the last approved one). Settled,
-- reversed and written-off advances need none.
CREATE FUNCTION public._special_advance_provision_line(p_id uuid, p_individual numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text := (SELECT status FROM public.special_advances WHERE id = p_id);
  v_pos jsonb;
  v_gross bigint := 0;
  v_dpd integer := 0;
  v_min numeric := 0;
  v_ind numeric := p_individual;
  v_rate numeric := 0;
  v_held bigint := public._special_advance_allowance_held(p_id);
  v_req bigint := 0;
BEGIN
  IF v_ind IS NULL THEN  -- carry forward the individual rate of the latest approved review that set one
    SELECT l.individual_rate INTO v_ind
      FROM public.special_advance_provision_lines l
      JOIN public.special_advance_provision_reviews v ON v.id = l.review_id AND v.status = 'approved'
     WHERE l.advance_id = p_id
     ORDER BY v.decided_at DESC LIMIT 1;
  END IF;
  IF v_ind = 0 THEN v_ind := NULL; END IF;
  IF v_status = 'disbursed' THEN
    v_pos := public._special_advance_position(p_id);
    v_gross := (v_pos ->> 'outstanding')::bigint;
    v_dpd := COALESCE((SELECT max(public._special_advance_kampala_today() - (i ->> 'due_date')::date)
                         FROM jsonb_array_elements(v_pos -> 'instalments') i
                        WHERE (i ->> 'outstanding')::bigint > 0 AND (i ->> 'due_date') IS NOT NULL
                          AND (i ->> 'due_date')::date < public._special_advance_kampala_today()), 0);
    v_min := public._special_advance_minimum_rate(v_dpd);
    v_rate := GREATEST(v_min, COALESCE(v_ind, 0));
    v_req := round(v_gross * v_rate / 100)::bigint;  -- half up, whole UGX
  ELSE
    v_ind := NULL;
  END IF;
  RETURN jsonb_build_object('advance_id', p_id, 'status', v_status, 'gross_outstanding', v_gross, 'days_past_due', v_dpd,
                            'minimum_rate', v_min, 'individual_rate', v_ind, 'applied_rate', v_rate,
                            'required_allowance', v_req, 'held_before', v_held, 'delta', v_req - v_held);
END $$;

-- The lines a review would post now: every advance that is paid out or still holds an allowance, with any change.
CREATE FUNCTION public._special_advance_provision_proposal(p_individual jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb := '[]'::jsonb;
  a record;
  l jsonb;
  k text;
  v_rate numeric;
BEGIN
  -- explicit individual rates: a paid-out advance, 0-100 with two decimals, never below the minimum
  FOR k IN SELECT jsonb_object_keys(COALESCE(p_individual, '{}'::jsonb)) LOOP
    BEGIN v_rate := (p_individual ->> k)::numeric; EXCEPTION WHEN others THEN v_rate := NULL; END;
    IF v_rate IS NULL OR v_rate < 0 OR v_rate > 100 OR v_rate <> round(v_rate, 2)
       OR NOT EXISTS (SELECT 1 FROM public.special_advances s WHERE s.id::text = k AND s.status = 'disbursed') THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = jsonb_build_array('individual_rates', k)::text;
    END IF;
    l := public._special_advance_provision_line(k::uuid, NULL);
    IF v_rate > 0 AND v_rate < (l ->> 'minimum_rate')::numeric THEN
      RAISE EXCEPTION 'INDIVIDUAL_RATE_BELOW_MINIMUM' USING ERRCODE = '22023',
        DETAIL = jsonb_build_object('advance_id', k, 'minimum_rate', (l ->> 'minimum_rate')::numeric)::text;
    END IF;
  END LOOP;
  FOR a IN
    SELECT s.id FROM public.special_advances s
     WHERE s.status = 'disbursed' OR public._special_advance_allowance_held(s.id) <> 0
     ORDER BY s.reference
  LOOP
    l := public._special_advance_provision_line(a.id, CASE WHEN p_individual ? a.id::text THEN (p_individual ->> a.id::text)::numeric END);
    IF (l ->> 'delta')::bigint <> 0 OR p_individual ? a.id::text THEN
      v := v || jsonb_build_array(l || jsonb_build_object('reference', (SELECT reference FROM public.special_advances WHERE id = a.id)));
    END IF;
  END LOOP;
  RETURN v;
END $$;

-- ── Replaced: status edge disbursed -> written_off (only inside an approved write-off) ─────────────
CREATE OR REPLACE FUNCTION public._special_advance_guard_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_edge text := OLD.status || '>' || NEW.status;
BEGIN
  IF (NEW.id, NEW.reference, NEW.borrower_kind, NEW.borrower_user_id, NEW.external_borrower_id,
      NEW.principal, NEW.rate_percent, NEW.rate_basis, NEW.term_days, NEW.frequency,
      NEW.access_fee, NEW.registration_fee, NEW.total_repayable, NEW.instalments, NEW.instalment_amount, NEW.calc_version,
      NEW.purpose, NEW.idempotency_key, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.reference, OLD.borrower_kind, OLD.borrower_user_id, OLD.external_borrower_id,
      OLD.principal, OLD.rate_percent, OLD.rate_basis, OLD.term_days, OLD.frequency,
      OLD.access_fee, OLD.registration_fee, OLD.total_repayable, OLD.instalments, OLD.instalment_amount, OLD.calc_version,
      OLD.purpose, OLD.idempotency_key, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_TERMS_IMMUTABLE' USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND v_edge NOT IN (
       'pending_approval>approved', 'pending_approval>rejected', 'pending_approval>cancelled',
       'approved>disbursed', 'approved>cancelled', 'disbursed>settled',
       'settled>disbursed', 'disbursed>reversed', 'disbursed>written_off') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = v_edge;
  END IF;

  -- decision columns: changeable only in their own transition
  IF (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at)
     AND v_edge <> 'pending_approval>approved' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'approval';
  END IF;
  IF (NEW.rejected_by, NEW.rejected_at) IS DISTINCT FROM (OLD.rejected_by, OLD.rejected_at)
     AND v_edge <> 'pending_approval>rejected' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'rejection';
  END IF;
  IF (NEW.cancelled_by, NEW.cancelled_at) IS DISTINCT FROM (OLD.cancelled_by, OLD.cancelled_at)
     AND v_edge NOT IN ('pending_approval>cancelled', 'approved>cancelled') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'cancellation';
  END IF;
  IF NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
     AND v_edge NOT IN ('pending_approval>approved', 'pending_approval>rejected', 'pending_approval>cancelled', 'approved>cancelled') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'reason';
  END IF;
  IF (NEW.payout_date, NEW.disbursed_by, NEW.disbursed_at) IS DISTINCT FROM (OLD.payout_date, OLD.disbursed_by, OLD.disbursed_at)
     AND v_edge <> 'approved>disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'payout';
  END IF;
  -- settled_at is set on settlement and cleared only when an approved repayment reversal reopens the advance
  IF NEW.settled_at IS DISTINCT FROM OLD.settled_at
     AND NOT (v_edge = 'disbursed>settled' OR (v_edge = 'settled>disbursed' AND NEW.settled_at IS NULL)) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'settlement';
  END IF;
  IF NEW.planned_payout_date IS DISTINCT FROM OLD.planned_payout_date AND OLD.status NOT IN ('pending_approval', 'approved') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'planned payout date';
  END IF;

  -- CFO is the sole authority: the approver must hold an enabled cfo role now.
  IF v_edge = 'pending_approval>approved' AND NOT public._has_enabled_role(NEW.approved_by, ARRAY['cfo']) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_APPROVER_NOT_CFO' USING ERRCODE = '42501';
  END IF;
  -- the two correction edges happen only inside an approved correction (special_advance_decide_correction)
  IF v_edge IN ('settled>disbursed', 'disbursed>reversed')
     AND COALESCE(current_setting('special_advance.correction', true), '') = '' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = v_edge;
  END IF;
  -- a write-off happens only inside an approved write-off (special_advance_decide_write_off)
  IF v_edge = 'disbursed>written_off' AND COALESCE(current_setting('special_advance.write_off', true), '') = '' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = v_edge;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

-- ── Replaced: audit names the write-off ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._special_advance_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, details)
    VALUES (NEW.id, 'created', NULL, NEW.status, NEW.created_by, jsonb_build_object(
      'reference', NEW.reference, 'borrower_kind', NEW.borrower_kind, 'borrower_user_id', NEW.borrower_user_id,
      'external_borrower_id', NEW.external_borrower_id, 'principal', NEW.principal, 'rate_percent', NEW.rate_percent,
      'rate_basis', NEW.rate_basis, 'term_days', NEW.term_days, 'frequency', NEW.frequency, 'access_fee', NEW.access_fee,
      'registration_fee', NEW.registration_fee, 'total_repayable', NEW.total_repayable, 'instalments', NEW.instalments,
      'calc_version', NEW.calc_version));
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'written_off' THEN
    INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, details)
    VALUES (NEW.id, 'written_off', OLD.status, NEW.status, COALESCE(auth.uid(), NEW.approved_by),
            jsonb_build_object('write_off', NULLIF(current_setting('special_advance.write_off', true), '')));
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status = 'settled' OR NEW.status = 'reversed') THEN
    -- correction transitions: the actor is the approving CFO; the correction is named in the details
    INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, details)
    VALUES (NEW.id, CASE WHEN NEW.status = 'reversed' THEN 'reversed' ELSE 'reopened' END, OLD.status, NEW.status,
            COALESCE(auth.uid(), NEW.approved_by),
            jsonb_build_object('correction', NULLIF(current_setting('special_advance.correction', true), '')));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
    VALUES (NEW.id,
            CASE NEW.status WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' WHEN 'cancelled' THEN 'cancelled'
                            WHEN 'disbursed' THEN 'disbursed' ELSE 'settled' END,
            OLD.status, NEW.status,
            CASE NEW.status WHEN 'approved' THEN NEW.approved_by WHEN 'rejected' THEN NEW.rejected_by
                            WHEN 'cancelled' THEN NEW.cancelled_by WHEN 'disbursed' THEN NEW.disbursed_by
                            ELSE COALESCE(auth.uid(), NEW.approved_by) END,
            NEW.decision_reason,
            CASE WHEN NEW.status = 'disbursed' THEN jsonb_build_object('payout_date', NEW.payout_date) END);
  END IF;
  RETURN NULL;
END $$;

-- ── Replaced: a proof file is used once across every Special Advances record ───────────────────────
CREATE OR REPLACE FUNCTION public._special_advance_check_proof(p_advance uuid, p_path text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_path text := NULLIF(btrim(COALESCE(p_path, '')), '');
BEGIN
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'PROOF_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Attach the receipt or statement for this payment';
  END IF;
  IF v_path !~ ('^advances/' || p_advance::text || '/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$') THEN
    RAISE EXCEPTION 'PROOF_PATH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'special-advance-proofs' AND o.name = v_path) THEN
    RAISE EXCEPTION 'PROOF_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advances s WHERE s.payout_proof_path = v_path)
     OR EXISTS (SELECT 1 FROM public.special_advance_repayments r WHERE r.proof_path = v_path)
     OR EXISTS (SELECT 1 FROM public.special_advance_corrections c WHERE c.proof_path = v_path)
     OR EXISTS (SELECT 1 FROM public.special_advance_write_offs w WHERE w.proof_path = v_path)
     OR EXISTS (SELECT 1 FROM public.special_advance_recoveries x WHERE x.proof_path = v_path) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_USED' USING ERRCODE = '23505';
  END IF;
  RETURN v_path;
END $$;

-- ── Replaced: eligibility also refuses a borrower with a written-off Special Advance (safety default) ──
CREATE OR REPLACE FUNCTION public._special_advance_eligibility(
  p_kind text, p_user uuid, p_phone text, p_national_id text, p_registration_number text, p_exclude uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v text[] := '{}';
  v_phone text := NULLIF(public._special_advance_norm_phone(p_phone), '');
  v_nin text := NULLIF(upper(btrim(COALESCE(p_national_id, ''))), '');
  v_reg text := NULLIF(upper(btrim(COALESCE(p_registration_number, ''))), '');
BEGIN
  IF p_kind = 'welile_user' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user) THEN
      RETURN ARRAY['UNKNOWN_ACCOUNT'];
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_user AND pr.deleted_at IS NOT NULL) THEN
      v := v || 'ACCOUNT_DELETED'::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user AND ur.enabled) THEN
      v := v || 'NO_ENABLED_ROLE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advances sa WHERE sa.borrower_user_id = p_user
                AND sa.status IN ('pending_approval', 'approved', 'disbursed') AND sa.id IS DISTINCT FROM p_exclude) THEN
      v := v || 'OPEN_SPECIAL_ADVANCE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advances sa WHERE sa.borrower_user_id = p_user AND sa.status = 'written_off'
                AND sa.id IS DISTINCT FROM p_exclude) THEN
      v := v || 'WRITTEN_OFF_SPECIAL_ADVANCE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.agent_advances a WHERE a.agent_id = p_user AND a.status::text = 'overdue'
                AND COALESCE(a.outstanding_balance, 0) > 0) THEN
      v := v || 'OVERDUE_AGENT_ADVANCE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_advances b WHERE b.tenant_id = p_user AND b.status::text = 'defaulted'
                AND COALESCE(b.outstanding_balance, 0) > 0) THEN
      v := v || 'DEFAULTED_BUSINESS_ADVANCE'::text;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.special_advances sa
                 JOIN public.special_advance_external_borrowers eb ON eb.id = sa.external_borrower_id
                WHERE sa.status IN ('pending_approval', 'approved', 'disbursed') AND sa.id IS DISTINCT FROM p_exclude
                  AND ((v_phone IS NOT NULL AND public._special_advance_norm_phone(eb.phone) = v_phone)
                       OR (v_nin IS NOT NULL AND upper(eb.national_id) = v_nin)
                       OR (v_reg IS NOT NULL AND upper(btrim(eb.registration_number)) = v_reg))) THEN
      v := v || 'OPEN_SPECIAL_ADVANCE'::text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advances sa
                 JOIN public.special_advance_external_borrowers eb ON eb.id = sa.external_borrower_id
                WHERE sa.status = 'written_off' AND sa.id IS DISTINCT FROM p_exclude
                  AND ((v_phone IS NOT NULL AND public._special_advance_norm_phone(eb.phone) = v_phone)
                       OR (v_nin IS NOT NULL AND upper(eb.national_id) = v_nin)
                       OR (v_reg IS NOT NULL AND upper(btrim(eb.registration_number)) = v_reg))) THEN
      v := v || 'WRITTEN_OFF_SPECIAL_ADVANCE'::text;
    END IF;
  END IF;
  RETURN v;
END $$;

-- ── Provision review: preview, request (maker), decide (checker) ──────────────────────────────────
-- p_request: {individual_rates: {<advance id>: <percent>}} (optional). Read-only.
CREATE FUNCTION public.special_advance_provision_preview(p_request jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lines jsonb;
BEGIN
  PERFORM public._special_advance_require_cfo();
  v_lines := public._special_advance_provision_proposal(COALESCE(p_request -> 'individual_rates', '{}'::jsonb));
  RETURN jsonb_build_object('as_of_date', public._special_advance_kampala_today(), 'lines', v_lines,
    'total_delta', COALESCE((SELECT sum((l ->> 'delta')::bigint) FROM jsonb_array_elements(v_lines) l), 0),
    'allowance_held', COALESCE((SELECT sum(public._special_advance_allowance_held(s.id)) FROM public.special_advances s), 0));
END $$;

CREATE FUNCTION public._special_advance_provision_review_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(v) || jsonb_build_object(
    'requested_by_name', NULLIF(btrim(rp.full_name), ''), 'decided_by_name', NULLIF(btrim(dp.full_name), ''),
    'lines', COALESCE((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('reference', s.reference) ORDER BY s.reference)
                         FROM public.special_advance_provision_lines l JOIN public.special_advances s ON s.id = l.advance_id
                        WHERE l.review_id = v.id), '[]'::jsonb))
    FROM public.special_advance_provision_reviews v
    LEFT JOIN public.profiles rp ON rp.id = v.requested_by
    LEFT JOIN public.profiles dp ON dp.id = v.decided_by
   WHERE v.id = p_id;
$$;

-- p_request: {individual_rates, note, idempotency_key}. Records a pending review with its lines; posts nothing.
CREATE FUNCTION public.special_advance_request_provision_review(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_note text := public._special_advance_reason(p_request ->> 'note', false);
  v_rates jsonb := COALESCE(p_request -> 'individual_rates', '{}'::jsonb);
  e public.special_advance_provision_reviews%ROWTYPE;
  v_lines jsonb;
  l jsonb;
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_rates) <> 'object' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["individual_rates"]';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:provision_review', 0));
  SELECT * INTO e FROM public.special_advance_provision_reviews WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.requested_by = v_actor AND e.note IS NOT DISTINCT FROM v_note THEN
      RETURN public._special_advance_provision_review_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_provision_reviews WHERE status = 'pending') THEN
    RAISE EXCEPTION 'PROVISION_REVIEW_ALREADY_PENDING' USING ERRCODE = '23505';
  END IF;
  v_lines := public._special_advance_provision_proposal(v_rates);
  IF jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'NOTHING_TO_PROVISION' USING ERRCODE = '22023',
      DETAIL = 'Every allowance already matches what is required';
  END IF;
  INSERT INTO public.special_advance_provision_reviews (id, reference, as_of_date, note, total_delta, idempotency_key, requested_by)
  VALUES (v_id, 'SAP-' || lpad(nextval('public.special_advance_provision_seq')::text, 6, '0'), public._special_advance_kampala_today(),
          v_note, (SELECT sum((x ->> 'delta')::bigint) FROM jsonb_array_elements(v_lines) x), v_key, v_actor);
  FOR l IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    INSERT INTO public.special_advance_provision_lines (review_id, advance_id, gross_outstanding, days_past_due, minimum_rate,
                                                        individual_rate, applied_rate, required_allowance, held_before, delta)
    VALUES (v_id, (l ->> 'advance_id')::uuid, (l ->> 'gross_outstanding')::bigint, (l ->> 'days_past_due')::int,
            (l ->> 'minimum_rate')::numeric, (l ->> 'individual_rate')::numeric, (l ->> 'applied_rate')::numeric,
            (l ->> 'required_allowance')::bigint, (l ->> 'held_before')::bigint, (l ->> 'delta')::bigint);
  END LOOP;
  RETURN public._special_advance_provision_review_json(v_id) || jsonb_build_object('replayed', false);
END $$;

-- p_decision: 'approve' | 'reject' (a different enabled CFO; rejection needs a note) | 'withdraw' (the requester).
-- Approval recomputes every line; if any figure moved since the request the review is refused as stale (reject or
-- withdraw it and request a new one). Each non-zero line posts once (key 'special_advance:provision:<line id>').
CREATE FUNCTION public.special_advance_decide_provision_review(p_review_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_note text := public._special_advance_reason(p_note, p_decision = 'reject');
  v public.special_advance_provision_reviews%ROWTYPE;
  v_target text := CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'withdraw' THEN 'withdrawn' END;
  ln public.special_advance_provision_lines%ROWTYPE;
  l jsonb;
  s public.special_advances%ROWTYPE;
  v_today date := public._special_advance_kampala_today();
  v_src jsonb;
  v_amt bigint;
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["decision"]';
  END IF;
  SELECT * INTO v FROM public.special_advance_provision_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROVISION_REVIEW_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v.status <> 'pending' THEN
    IF v.status = v_target AND v.decided_by = v_actor THEN
      RETURN public._special_advance_provision_review_json(v.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'PROVISION_REVIEW_ALREADY_DECIDED' USING ERRCODE = '22023', DETAIL = v.status;
  END IF;
  IF p_decision = 'withdraw' THEN
    IF v.requested_by <> v_actor THEN
      RAISE EXCEPTION 'ONLY_REQUESTER_MAY_WITHDRAW' USING ERRCODE = '42501';
    END IF;
  ELSIF v.requested_by = v_actor THEN
    RAISE EXCEPTION 'SECOND_CFO_REQUIRED' USING ERRCODE = '42501',
      DETAIL = 'A different CFO must approve or reject a provision review you requested';
  END IF;
  IF p_decision IN ('reject', 'withdraw') THEN
    UPDATE public.special_advance_provision_reviews
       SET status = v_target, decided_by = v_actor, decided_at = clock_timestamp(), decision_note = v_note WHERE id = v.id;
    RETURN public._special_advance_provision_review_json(v.id) || jsonb_build_object('replayed', false);
  END IF;

  -- approve: lock the advances (in a fixed order), then every line must still be exactly right
  PERFORM 1 FROM public.special_advances a
    WHERE a.id IN (SELECT advance_id FROM public.special_advance_provision_lines WHERE review_id = v.id)
    ORDER BY a.id FOR UPDATE;
  FOR ln IN SELECT * FROM public.special_advance_provision_lines WHERE review_id = v.id ORDER BY advance_id LOOP
    l := public._special_advance_provision_line(ln.advance_id, COALESCE(ln.individual_rate, 0));
    IF (l ->> 'gross_outstanding')::bigint <> ln.gross_outstanding OR (l ->> 'required_allowance')::bigint <> ln.required_allowance
       OR (l ->> 'held_before')::bigint <> ln.held_before THEN
      RAISE EXCEPTION 'PROVISION_REVIEW_STALE' USING ERRCODE = '40001',
        DETAIL = jsonb_build_object('advance_id', ln.advance_id, 'now', l)::text;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public._special_advance_provision_proposal('{}'::jsonb)) x
              WHERE (x ->> 'delta')::bigint <> 0
                AND NOT EXISTS (SELECT 1 FROM public.special_advance_provision_lines z WHERE z.review_id = v.id AND z.advance_id = (x ->> 'advance_id')::uuid)) THEN
    RAISE EXCEPTION 'PROVISION_REVIEW_STALE' USING ERRCODE = '40001', DETAIL = 'Another advance now needs a provision change';
  END IF;

  UPDATE public.special_advance_provision_reviews
     SET status = 'approved', decided_by = v_actor, decided_at = clock_timestamp(), decision_note = v_note WHERE id = v.id;
  FOR ln IN SELECT * FROM public.special_advance_provision_lines WHERE review_id = v.id AND delta <> 0 ORDER BY advance_id LOOP
    SELECT * INTO s FROM public.special_advances WHERE id = ln.advance_id;
    v_amt := abs(ln.delta);
    v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_provision_lines', 'source_id', ln.id,
                                'reference_id', s.reference, 'currency', 'UGX', 'amount', v_amt,
                                'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
    v_group := public.create_ledger_transaction(jsonb_build_array(
      v_src || jsonb_build_object('category', 'special_advance_impairment_charge',
                                  'direction', CASE WHEN ln.delta > 0 THEN 'cash_out' ELSE 'cash_in' END,
                                  'description', format('Special Advance %s impairment %s (%s, %s%% of UGX %s, %s days past due)', s.reference,
                                                        CASE WHEN ln.delta > 0 THEN 'raised' ELSE 'released' END, v.reference,
                                                        ln.applied_rate, ln.gross_outstanding, ln.days_past_due)),
      v_src || jsonb_build_object('category', 'special_advance_impairment_allowance',
                                  'direction', CASE WHEN ln.delta > 0 THEN 'cash_in' ELSE 'cash_out' END,
                                  'description', format('Special Advance %s impairment allowance %s (%s)', s.reference,
                                                        CASE WHEN ln.delta > 0 THEN 'increased' ELSE 'reduced' END, v.reference))),
      'special_advance:provision:' || ln.id::text, false);
    UPDATE public.special_advance_provision_lines SET ledger_group_id = v_group WHERE id = ln.id;
    INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
    VALUES (s.id, 'provision_posted', s.status, s.status, v_actor, v_note,
            jsonb_build_object('review', v.reference, 'delta', ln.delta, 'required_allowance', ln.required_allowance,
                               'applied_rate', ln.applied_rate, 'days_past_due', ln.days_past_due, 'ledger_group_id', v_group));
  END LOOP;
  RETURN public._special_advance_provision_review_json(v.id) || jsonb_build_object('replayed', false);
END $$;

-- ── Write-off: request (maker), decide (checker) ───────────────────────────────────────────────────
CREATE FUNCTION public._special_advance_write_off_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(w) || jsonb_build_object('advance_reference', a.reference,
    'requested_by_name', NULLIF(btrim(rp.full_name), ''), 'decided_by_name', NULLIF(btrim(dp.full_name), ''))
    FROM public.special_advance_write_offs w
    JOIN public.special_advances a ON a.id = w.advance_id
    LEFT JOIN public.profiles rp ON rp.id = w.requested_by
    LEFT JOIN public.profiles dp ON dp.id = w.decided_by
   WHERE w.id = p_id;
$$;

-- p_request: {reason, proof_path, idempotency_key}. Records a pending write-off of the whole gross outstanding.
CREATE FUNCTION public.special_advance_request_write_off(p_id uuid, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_reason text := NULLIF(btrim(COALESCE(p_request ->> 'reason', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_request ->> 'proof_path', '')), '');
  a public.special_advances%ROWTYPE;
  e public.special_advance_write_offs%ROWTYPE;
  v_gross bigint;
  v_held bigint;
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:write_off:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_write_offs WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.requested_by = v_actor AND e.proof_path = v_proof AND e.reason = v_reason THEN
      RETURN public._special_advance_write_off_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 20 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Explain the write-off in 20 to 1000 characters';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_WRITABLE_OFF' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_write_offs w WHERE w.advance_id = a.id AND w.status = 'pending') THEN
    RAISE EXCEPTION 'WRITE_OFF_ALREADY_PENDING' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_corrections c WHERE c.advance_id = a.id AND c.status = 'pending') THEN
    RAISE EXCEPTION 'CORRECTION_ALREADY_PENDING' USING ERRCODE = '23505';
  END IF;
  v_gross := (public._special_advance_position(a.id) ->> 'outstanding')::bigint;
  v_held := public._special_advance_allowance_held(a.id);
  IF v_gross <= 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_WRITABLE_OFF' USING ERRCODE = '22023', DETAIL = 'nothing outstanding';
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D9: the evidence that the balance cannot be collected
  INSERT INTO public.special_advance_write_offs (id, reference, advance_id, gross_amount, allowance_released, net_loss, reason,
                                                 proof_path, idempotency_key, requested_by)
  VALUES (v_id, 'SAW-' || lpad(nextval('public.special_advance_write_off_seq')::text, 6, '0'), a.id, v_gross, v_held,
          v_gross - v_held, v_reason, v_proof, v_key, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'write_off_requested', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('write_off_id', v_id, 'gross_amount', v_gross, 'allowance_held', v_held));
  RETURN public._special_advance_write_off_json(v_id) || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION public.special_advance_decide_write_off(p_write_off_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_note text := public._special_advance_reason(p_note, p_decision = 'reject');
  w public.special_advance_write_offs%ROWTYPE;
  a public.special_advances%ROWTYPE;
  v_target text := CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'withdraw' THEN 'withdrawn' END;
  v_today date := public._special_advance_kampala_today();
  v_src jsonb;
  v_legs jsonb;
  v_desc text;
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["decision"]';
  END IF;
  SELECT * INTO w FROM public.special_advance_write_offs WHERE id = p_write_off_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WRITE_OFF_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF w.status <> 'pending' THEN
    IF w.status = v_target AND w.decided_by = v_actor THEN
      RETURN public._special_advance_write_off_json(w.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'WRITE_OFF_ALREADY_DECIDED' USING ERRCODE = '22023', DETAIL = w.status;
  END IF;
  IF p_decision = 'withdraw' THEN
    IF w.requested_by <> v_actor THEN
      RAISE EXCEPTION 'ONLY_REQUESTER_MAY_WITHDRAW' USING ERRCODE = '42501';
    END IF;
  ELSIF w.requested_by = v_actor THEN  -- D9 maker-checker
    RAISE EXCEPTION 'SECOND_CFO_REQUIRED' USING ERRCODE = '42501',
      DETAIL = 'A different CFO must approve or reject a write-off you requested';
  END IF;
  IF p_decision IN ('reject', 'withdraw') THEN
    UPDATE public.special_advance_write_offs
       SET status = v_target, decided_by = v_actor, decided_at = clock_timestamp(), decision_note = v_note WHERE id = w.id;
    INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
    SELECT w.advance_id, 'write_off_' || v_target, s.status, s.status, v_actor, v_note, jsonb_build_object('write_off_id', w.id)
      FROM public.special_advances s WHERE s.id = w.advance_id;
    RETURN public._special_advance_write_off_json(w.id) || jsonb_build_object('replayed', false);
  END IF;

  -- approve: the balance and the allowance must still be what was requested
  SELECT * INTO a FROM public.special_advances WHERE id = w.advance_id FOR UPDATE;
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_WRITABLE_OFF' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_corrections c WHERE c.advance_id = a.id AND c.status = 'pending') THEN
    RAISE EXCEPTION 'CORRECTION_ALREADY_PENDING' USING ERRCODE = '23505';
  END IF;
  IF (public._special_advance_position(a.id) ->> 'outstanding')::bigint <> w.gross_amount
     OR public._special_advance_allowance_held(a.id) <> w.allowance_released THEN
    RAISE EXCEPTION 'WRITE_OFF_STALE' USING ERRCODE = '40001',
      DETAIL = 'The balance or the allowance changed since the request; withdraw or reject it and request again';
  END IF;

  v_desc := format('Special Advance %s write-off %s', a.reference, w.reference);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_write_offs', 'source_id', w.id,
                              'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  v_legs := jsonb_build_array(
    v_src || jsonb_build_object('direction', 'cash_in', 'amount', w.gross_amount, 'category', 'special_advance_write_off',
                                'description', v_desc || ': gross receivable written off'));
  IF w.allowance_released > 0 THEN
    v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', w.allowance_released,
                                'category', 'special_advance_impairment_allowance', 'description', v_desc || ': allowance used'));
  END IF;
  IF w.net_loss > 0 THEN
    v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', w.net_loss,
                                'category', 'special_advance_write_off_loss', 'description', v_desc || ': loss not covered by the allowance'));
  ELSIF w.net_loss < 0 THEN
    v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', -w.net_loss,
                                'category', 'special_advance_impairment_charge', 'description', v_desc || ': excess allowance released'));
  END IF;
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:write_off:' || w.id::text, false);

  UPDATE public.special_advance_write_offs
     SET status = 'approved', decided_by = v_actor, decided_at = clock_timestamp(), decision_note = v_note, ledger_group_id = v_group
   WHERE id = w.id;
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'write_off_approved', a.status, a.status, v_actor, v_note,
          jsonb_build_object('write_off_id', w.id, 'gross_amount', w.gross_amount, 'allowance_released', w.allowance_released,
                             'net_loss', w.net_loss, 'ledger_group_id', v_group));
  PERFORM set_config('special_advance.write_off', w.id::text, true);
  UPDATE public.special_advances SET status = 'written_off' WHERE id = a.id;
  PERFORM set_config('special_advance.write_off', '', true);
  RETURN public._special_advance_write_off_json(w.id) || jsonb_build_object('replayed', false);
END $$;

-- ── Recovery after write-off (D10) ─────────────────────────────────────────────────────────────────
-- p_recovery: {amount, received_date, method, reference, note, proof_path, idempotency_key}. DR A1 / CR X4.
CREATE FUNCTION public.special_advance_record_recovery(p_id uuid, p_recovery jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_key text := btrim(COALESCE(p_recovery ->> 'idempotency_key', ''));
  v_amount numeric;
  v_date date;
  v_method text := p_recovery ->> 'method';
  v_ref text := NULLIF(btrim(COALESCE(p_recovery ->> 'reference', '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_recovery ->> 'note', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_recovery ->> 'proof_path', '')), '');
  a public.special_advances%ROWTYPE;
  w public.special_advance_write_offs%ROWTYPE;
  e public.special_advance_recoveries%ROWTYPE;
  v_errs text[] := '{}';
  v_left bigint;
  v_rec uuid := gen_random_uuid();
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:recovery:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_recoveries WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND COALESCE(p_recovery ->> 'amount', '') ~ '^[0-9]+$'
       AND e.amount = (p_recovery ->> 'amount')::bigint AND e.reference = v_ref AND e.method = v_method AND e.proof_path = v_proof THEN
      RETURN to_jsonb(e) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.status <> 'written_off' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_WRITTEN_OFF' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  SELECT * INTO w FROM public.special_advance_write_offs WHERE advance_id = a.id AND status = 'approved';
  BEGIN v_amount := (p_recovery ->> 'amount')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  BEGIN v_date := (p_recovery ->> 'received_date')::date; EXCEPTION WHEN others THEN v_date := NULL; END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> trunc(v_amount) THEN v_errs := v_errs || 'amount'::text; END IF;
  IF v_date IS NULL OR v_date > v_today OR v_date < (w.decided_at AT TIME ZONE 'Africa/Kampala')::date THEN
    v_errs := v_errs || 'received_date'::text;
  END IF;
  IF v_method IS NULL OR v_method NOT IN ('mobile_money', 'bank_transfer') THEN v_errs := v_errs || 'method'::text; END IF;
  IF v_ref IS NULL OR length(v_ref) NOT BETWEEN 3 AND 100 THEN v_errs := v_errs || 'reference'::text; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN v_errs := v_errs || 'note'::text; END IF;
  IF cardinality(v_errs) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = to_jsonb(v_errs)::text;
  END IF;
  -- one provider transaction is booked once, whether as a repayment or a recovery
  IF EXISTS (SELECT 1 FROM public.special_advance_recoveries r WHERE r.method = v_method AND upper(btrim(r.reference)) = upper(v_ref))
     OR EXISTS (SELECT 1 FROM public.special_advance_repayments r WHERE r.method = v_method AND upper(btrim(r.reference)) = upper(v_ref)
                 AND r.reversed_by_correction IS NULL) THEN
    RAISE EXCEPTION 'REPAYMENT_REFERENCE_ALREADY_RECORDED' USING ERRCODE = '23505';
  END IF;
  v_left := w.gross_amount - COALESCE((SELECT sum(amount) FROM public.special_advance_recoveries WHERE advance_id = a.id), 0);
  IF v_amount > v_left THEN
    RAISE EXCEPTION 'RECOVERY_EXCEEDS_WRITTEN_OFF' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('recoverable', v_left)::text;
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);

  v_group := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_amount::bigint,
                       'category', 'special_advance_recovery_received', 'source_table', 'special_advance_recoveries', 'source_id', v_rec,
                       'reference_id', a.reference, 'currency', 'UGX', 'transaction_date', (v_date::timestamp AT TIME ZONE 'Africa/Kampala'),
                       'description', format('Special Advance %s recovery after write-off by %s, ref %s', a.reference, replace(v_method, '_', ' '), v_ref)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_amount::bigint,
                       'category', 'special_advance_recovery_income', 'source_table', 'special_advance_recoveries', 'source_id', v_rec,
                       'reference_id', a.reference, 'currency', 'UGX', 'transaction_date', (v_date::timestamp AT TIME ZONE 'Africa/Kampala'),
                       'description', format('Special Advance %s credit loss reduced by recovery', a.reference))),
    'special_advance:recovery:' || v_key, false);
  INSERT INTO public.special_advance_recoveries (id, advance_id, amount, received_date, method, reference, proof_path, note,
                                                 idempotency_key, ledger_group_id, recorded_by)
  VALUES (v_rec, a.id, v_amount::bigint, v_date, v_method, v_ref, v_proof, v_note, v_key, v_group, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, details)
  VALUES (a.id, 'recovery_recorded', a.status, a.status, v_actor,
          jsonb_build_object('recovery_id', v_rec, 'amount', v_amount::bigint, 'reference', v_ref, 'ledger_group_id', v_group));
  SELECT * INTO e FROM public.special_advance_recoveries WHERE id = v_rec;
  RETURN to_jsonb(e) || jsonb_build_object('replayed', false);
END $$;

-- ── Lists ──────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.special_advance_list_provision_reviews(p_status text DEFAULT 'pending', p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._special_advance_require_cfo();
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["status"]';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(public._special_advance_provision_review_json(x.id) ORDER BY x.requested_at DESC)
                     FROM (SELECT v.id, v.requested_at FROM public.special_advance_provision_reviews v
                            WHERE p_status IS NULL OR v.status = p_status
                            ORDER BY v.requested_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)) x), '[]'::jsonb);
END $$;

CREATE FUNCTION public.special_advance_list_write_offs(p_status text DEFAULT 'pending', p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._special_advance_require_cfo();
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["status"]';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(public._special_advance_write_off_json(x.id) ORDER BY x.requested_at DESC)
                     FROM (SELECT w.id, w.requested_at FROM public.special_advance_write_offs w
                            WHERE p_status IS NULL OR w.status = p_status
                            ORDER BY w.requested_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) x), '[]'::jsonb);
END $$;

-- ── Replaced: the statement shows the allowance, write-off and recoveries ──────────────────────────
CREATE OR REPLACE FUNCTION public.special_advance_statement(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public._special_advance_require_cfo();
  v := public._special_advance_json(p_id);
  IF v IS NULL THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN v || jsonb_build_object(
    'position', public._special_advance_position(p_id),
    'repayments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'amount', r.amount, 'received_date', r.received_date, 'method', r.method, 'reference', r.reference,
        'note', r.note, 'recorded_by', r.recorded_by, 'recorded_at', r.recorded_at, 'ledger_group_id', r.ledger_group_id,
        'proof_path', r.proof_path, 'reversed_by_correction', r.reversed_by_correction) ORDER BY r.recorded_at)
      FROM public.special_advance_repayments r WHERE r.advance_id = p_id), '[]'::jsonb),
    'corrections', COALESCE((SELECT jsonb_agg(public._special_advance_correction_json(c.id) ORDER BY c.requested_at)
      FROM public.special_advance_corrections c WHERE c.advance_id = p_id), '[]'::jsonb),
    'allowance_held', public._special_advance_allowance_held(p_id),
    'provision', public._special_advance_provision_line(p_id, NULL),
    'provision_history', COALESCE((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('review', v2.reference, 'review_status', v2.status,
                                                                                       'decided_at', v2.decided_at) ORDER BY v2.requested_at)
      FROM public.special_advance_provision_lines l JOIN public.special_advance_provision_reviews v2 ON v2.id = l.review_id
     WHERE l.advance_id = p_id), '[]'::jsonb),
    'write_offs', COALESCE((SELECT jsonb_agg(public._special_advance_write_off_json(w.id) ORDER BY w.requested_at)
      FROM public.special_advance_write_offs w WHERE w.advance_id = p_id), '[]'::jsonb),
    'recoveries', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.recorded_at)
      FROM public.special_advance_recoveries x WHERE x.advance_id = p_id), '[]'::jsonb));
END $$;

-- ── Replaced: reconciliation covers A24 (gross), A25 (allowance) and the net receivable ────────────
CREATE OR REPLACE FUNCTION public.special_advance_reconciliation()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ledger numeric;
  v_sub numeric;
  v_rows jsonb;
  v_a25 numeric;
  v_held numeric;
  v_a25_rows jsonb;
BEGIN
  PERFORM public._special_advance_require_cfo();
  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END), 0) INTO v_ledger
    FROM public.general_ledger gl
    JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
                                     AND (m.wallet_bucket IS NULL OR m.wallet_bucket = gl.wallet_bucket)
   WHERE gl.category LIKE 'special\_advance\_%';
  SELECT COALESCE(sum((public._special_advance_position(a.id) ->> 'outstanding')::numeric), 0) INTO v_sub
    FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed', 'written_off');
  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'reference'), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object('reference', a.reference, 'status', a.status,
             'subledger_outstanding', (public._special_advance_position(a.id) ->> 'outstanding')::numeric,
             'ledger_balance', COALESCE((
               SELECT sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END)
                 FROM public.general_ledger gl
                 JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
                WHERE (gl.source_table = 'special_advances' AND gl.source_id = a.id)
                   OR (gl.source_table = 'special_advance_repayments' AND gl.source_id IN (SELECT r.id FROM public.special_advance_repayments r WHERE r.advance_id = a.id))
                   OR (gl.source_table = 'special_advance_corrections' AND gl.source_id IN (SELECT c.id FROM public.special_advance_corrections c WHERE c.advance_id = a.id))
                   OR (gl.source_table = 'special_advance_write_offs' AND gl.source_id IN (SELECT w.id FROM public.special_advance_write_offs w WHERE w.advance_id = a.id))), 0)) AS x
      FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed', 'written_off')) t
   WHERE (x ->> 'subledger_outstanding')::numeric <> (x ->> 'ledger_balance')::numeric;

  -- A25 is a contra-asset: its balance is the credit held (CR - DR)
  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN -gl.amount ELSE gl.amount END), 0) INTO v_a25
    FROM public.general_ledger gl
    JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A25'
                                     AND m.wallet_bucket IS NULL
   WHERE gl.category LIKE 'special\_advance\_%';
  SELECT COALESCE(sum(public._special_advance_allowance_held(a.id)), 0) INTO v_held FROM public.special_advances a;
  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'reference'), '[]'::jsonb) INTO v_a25_rows FROM (
    SELECT jsonb_build_object('reference', a.reference, 'status', a.status,
             'allowance_subledger', public._special_advance_allowance_held(a.id),
             'allowance_ledger', COALESCE((
               SELECT sum(CASE WHEN gl.direction = m.debit_when THEN -gl.amount ELSE gl.amount END)
                 FROM public.general_ledger gl
                 JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A25'
                WHERE (gl.source_table = 'special_advance_provision_lines' AND gl.source_id IN (SELECT l.id FROM public.special_advance_provision_lines l WHERE l.advance_id = a.id))
                   OR (gl.source_table = 'special_advance_write_offs' AND gl.source_id IN (SELECT w.id FROM public.special_advance_write_offs w WHERE w.advance_id = a.id))), 0)) AS x
      FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed', 'written_off')) t
   WHERE (x ->> 'allowance_subledger')::numeric <> (x ->> 'allowance_ledger')::numeric;

  RETURN jsonb_build_object('a24_ledger_balance', v_ledger, 'subledger_outstanding', v_sub,
                            'difference', v_ledger - v_sub,
                            'a25_ledger_balance', v_a25, 'allowance_subledger', v_held, 'allowance_difference', v_a25 - v_held,
                            'net_receivable', v_ledger - v_a25,
                            'balanced', v_ledger = v_sub AND jsonb_array_length(v_rows) = 0
                                        AND v_a25 = v_held AND jsonb_array_length(v_a25_rows) = 0,
                            'mismatched_advances', v_rows, 'mismatched_allowances', v_a25_rows);
END $$;

-- ── Privileges ─────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._special_advance_minimum_rate(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_guard_decided() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_guard_provision_line() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_allowance_held(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_provision_line(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_provision_proposal(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_provision_review_json(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_write_off_json(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.special_advance_provision_preview(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_request_provision_review(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_decide_provision_review(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_request_write_off(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_decide_write_off(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_record_recovery(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_list_provision_reviews(text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_list_write_offs(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_provision_preview(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_request_provision_review(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_decide_provision_review(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_request_write_off(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_decide_write_off(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_record_recovery(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_list_provision_reviews(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_list_write_offs(text, integer) TO authenticated;

DO $post$
BEGIN
  IF has_function_privilege('authenticated', 'public._special_advance_eligibility(text,uuid,text,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._special_advance_check_proof(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._special_advance_audit()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.special_advance_statement(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.special_advance_reconciliation()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.special_advance_reconciliation()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.special_advance_write_offs', 'INSERT')
     OR has_table_privilege('anon', 'public.special_advance_recoveries', 'SELECT') THEN
    RAISE EXCEPTION 'postcondition failed: a Special Advances privilege changed; nothing was changed';
  END IF;
END
$post$;

RESET lock_timeout;
