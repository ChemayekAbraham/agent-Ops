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
--   ONE step (CFO decision 2026-11-03, replacing the earlier request-then-approve design): Welile has one CFO, who
--       posts a provision review or a write-off in a single authorised action (enabled CFO, aal2). There is no pending
--       state, queue, approval, rejection or withdrawal; every record is append-only and written with its ledger group.
--   Provisions: the CFO previews (the server computes every paid-out advance's required allowance on its gross
--       outstanding and the difference to post) and posts; the figures are recomputed under lock when posting and,
--       if the CFO's preview total no longer matches, nothing posts (PROVISION_REVIEW_STALE).
--   D9  write-off: reason (20-1000 characters) + archived evidence file; posted by the CFO in one step. The whole gross
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
      ('public._special_advance_guard_update()', '672ef52ded23fec4188352f970710f88'),
      ('public._special_advance_audit()', 'd232dad990ab924d4c77ba0b277e69e4'),
      ('public._special_advance_check_proof(uuid,text)', 'd12aa37dc682ebe7f64b376e2255e263'),
      ('public.special_advance_statement(uuid)', 'bac2467b11f7438455d5965a8f7dacef'),
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
    'correction_posted',
    'written_off', 'write_off_posted', 'provision_posted', 'recovery_recorded'));

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

-- ── Provision reviews (posted in one step) ──────────────────────────────────────────────────────────────
CREATE SEQUENCE public.special_advance_provision_seq START 1;
CREATE SEQUENCE public.special_advance_write_off_seq START 1;

CREATE TABLE public.special_advance_provision_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^SAP-[0-9]{6,}$'),
  as_of_date date NOT NULL,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 5 AND 1000),
  total_delta bigint NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

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
  CONSTRAINT special_advance_provision_lines_posted CHECK ((delta = 0) = (ledger_group_id IS NULL)),
  CONSTRAINT special_advance_provision_lines_rate CHECK (applied_rate = GREATEST(minimum_rate, COALESCE(individual_rate, 0))),
  UNIQUE (review_id, advance_id)
);
CREATE INDEX special_advance_provision_lines_advance_idx ON public.special_advance_provision_lines (advance_id);

-- ── Write-offs (posted in one step) and recoveries ──────────────────────────────────────────────────────
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
  ledger_group_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
-- a written-off advance is terminal: one write-off per advance
CREATE UNIQUE INDEX special_advance_write_offs_one_per_advance ON public.special_advance_write_offs (advance_id);

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

-- Guards: every record is written once, with its posting, by an enabled CFO; posted figures never change; nothing is
-- deleted (_special_advance_guard_posted is Phase B's; provision lines and recoveries are append-only).
CREATE TRIGGER special_advance_provision_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON public.special_advance_provision_reviews
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_posted();
CREATE TRIGGER special_advance_write_offs_guard BEFORE INSERT OR UPDATE OR DELETE ON public.special_advance_write_offs
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_posted();
CREATE TRIGGER special_advance_provision_lines_append_only BEFORE UPDATE OR DELETE ON public.special_advance_provision_lines
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();
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
-- Held = posted provision movements - allowance released by write-offs (the subledger of A25).
CREATE FUNCTION public._special_advance_allowance_held(p_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (COALESCE((SELECT sum(l.delta) FROM public.special_advance_provision_lines l WHERE l.advance_id = p_id), 0)
        - COALESCE((SELECT sum(w.allowance_released) FROM public.special_advance_write_offs w WHERE w.advance_id = p_id), 0))::bigint;
$$;

-- What the allowance should be for one advance: on the gross outstanding of a paid-out (disbursed) advance, the higher
-- of the D7 minimum and the individual rate (p_individual; NULL = carry forward the last posted one). Settled,
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
  IF v_ind IS NULL THEN  -- carry forward the individual rate of the latest posted review that included this advance
    SELECT l.individual_rate INTO v_ind
      FROM public.special_advance_provision_lines l
      JOIN public.special_advance_provision_reviews v ON v.id = l.review_id
     WHERE l.advance_id = p_id
     ORDER BY v.recorded_at DESC, v.reference DESC LIMIT 1;
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

-- ── Replaced: status edge disbursed -> written_off (only inside a posted write-off) ─────────────
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
  -- settled_at is set on settlement and cleared only when a posted repayment reversal reopens the advance
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
  -- the two correction edges happen only inside a posted correction (special_advance_record_correction)
  IF v_edge IN ('settled>disbursed', 'disbursed>reversed')
     AND COALESCE(current_setting('special_advance.correction', true), '') = '' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_TRANSITION' USING ERRCODE = '42501', DETAIL = v_edge;
  END IF;
  -- a write-off happens only inside a posted write-off (special_advance_write_off)
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
    -- correction transitions: the actor is the CFO who posted it; the correction is named in the details
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

-- ── Provision review: preview, then post (one step) ──────────────────────────────────
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
    'recorded_by_name', NULLIF(btrim(rp.full_name), ''),
    'lines', COALESCE((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('reference', s.reference) ORDER BY s.reference)
                         FROM public.special_advance_provision_lines l JOIN public.special_advances s ON s.id = l.advance_id
                        WHERE l.review_id = v.id), '[]'::jsonb))
    FROM public.special_advance_provision_reviews v
    LEFT JOIN public.profiles rp ON rp.id = v.recorded_by
   WHERE v.id = p_id;
$$;

-- p_request: {individual_rates, note, idempotency_key, expected_total_delta}. The CFO's one authorised action (decision
-- 2026-11-03): locks the advances, computes every line now and posts each non-zero line at once (key
-- 'special_advance:provision:<line id>'), writing the append-only review and its lines in the same transaction.
-- expected_total_delta (optional, from the preview the CFO saw): if the figures moved since, nothing posts
-- (PROVISION_REVIEW_STALE) and the CFO previews again. A retry with the same key returns the posted review.
CREATE FUNCTION public.special_advance_post_provision_review(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_note text := public._special_advance_reason(p_request ->> 'note', false);
  v_rates jsonb := COALESCE(p_request -> 'individual_rates', '{}'::jsonb);
  v_expected text := NULLIF(btrim(COALESCE(p_request ->> 'expected_total_delta', '')), '');
  e public.special_advance_provision_reviews%ROWTYPE;
  v_lines jsonb;
  v_total bigint;
  l jsonb;
  s public.special_advances%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_ref text;
  v_line uuid;
  v_delta bigint;
  v_today date := public._special_advance_kampala_today();
  v_src jsonb;
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_rates) <> 'object' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["individual_rates"]';
  END IF;
  IF v_expected IS NOT NULL AND v_expected !~ '^-?[0-9]{1,15}$' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["expected_total_delta"]';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:provision_review', 0));
  SELECT * INTO e FROM public.special_advance_provision_reviews WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.recorded_by = v_actor AND e.note IS NOT DISTINCT FROM v_note THEN
      RETURN public._special_advance_provision_review_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  -- lock every advance a review can touch (in a fixed order), then compute against the records as they are now
  PERFORM 1 FROM public.special_advances a
    WHERE a.status = 'disbursed' OR public._special_advance_allowance_held(a.id) <> 0
    ORDER BY a.id FOR UPDATE;
  v_lines := public._special_advance_provision_proposal(v_rates);
  IF jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'NOTHING_TO_PROVISION' USING ERRCODE = '22023',
      DETAIL = 'Every allowance already matches what is required';
  END IF;
  v_total := (SELECT sum((x ->> 'delta')::bigint) FROM jsonb_array_elements(v_lines) x);
  IF v_expected IS NOT NULL AND v_expected::bigint <> v_total THEN
    RAISE EXCEPTION 'PROVISION_REVIEW_STALE' USING ERRCODE = '40001',
      DETAIL = jsonb_build_object('expected_total_delta', v_expected::bigint, 'total_delta', v_total)::text;
  END IF;

  v_ref := 'SAP-' || lpad(nextval('public.special_advance_provision_seq')::text, 6, '0');
  INSERT INTO public.special_advance_provision_reviews (id, reference, as_of_date, note, total_delta, idempotency_key, recorded_by)
  VALUES (v_id, v_ref, v_today, v_note, v_total, v_key, v_actor);
  FOR l IN SELECT * FROM jsonb_array_elements(v_lines) ORDER BY (value ->> 'advance_id') LOOP
    v_line := gen_random_uuid();
    v_delta := (l ->> 'delta')::bigint;
    v_group := NULL;
    SELECT * INTO s FROM public.special_advances WHERE id = (l ->> 'advance_id')::uuid;
    IF v_delta <> 0 THEN
      v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_provision_lines', 'source_id', v_line,
                                  'reference_id', s.reference, 'currency', 'UGX', 'amount', abs(v_delta),
                                  'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
      v_group := public.create_ledger_transaction(jsonb_build_array(
        v_src || jsonb_build_object('category', 'special_advance_impairment_charge',
                                    'direction', CASE WHEN v_delta > 0 THEN 'cash_out' ELSE 'cash_in' END,
                                    'description', format('Special Advance %s impairment %s (%s, %s%% of UGX %s, %s days past due)', s.reference,
                                                          CASE WHEN v_delta > 0 THEN 'raised' ELSE 'released' END, v_ref,
                                                          (l ->> 'applied_rate')::numeric, (l ->> 'gross_outstanding')::bigint,
                                                          (l ->> 'days_past_due')::int)),
        v_src || jsonb_build_object('category', 'special_advance_impairment_allowance',
                                    'direction', CASE WHEN v_delta > 0 THEN 'cash_in' ELSE 'cash_out' END,
                                    'description', format('Special Advance %s impairment allowance %s (%s)', s.reference,
                                                          CASE WHEN v_delta > 0 THEN 'increased' ELSE 'reduced' END, v_ref))),
        'special_advance:provision:' || v_line::text, false);
    END IF;
    INSERT INTO public.special_advance_provision_lines (id, review_id, advance_id, gross_outstanding, days_past_due, minimum_rate,
                                                        individual_rate, applied_rate, required_allowance, held_before, delta,
                                                        ledger_group_id)
    VALUES (v_line, v_id, s.id, (l ->> 'gross_outstanding')::bigint, (l ->> 'days_past_due')::int,
            (l ->> 'minimum_rate')::numeric, (l ->> 'individual_rate')::numeric, (l ->> 'applied_rate')::numeric,
            (l ->> 'required_allowance')::bigint, (l ->> 'held_before')::bigint, v_delta, v_group);
    IF v_delta <> 0 THEN
      INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
      VALUES (s.id, 'provision_posted', s.status, s.status, v_actor, v_note,
              jsonb_build_object('review', v_ref, 'delta', v_delta, 'required_allowance', (l ->> 'required_allowance')::bigint,
                                 'applied_rate', (l ->> 'applied_rate')::numeric, 'days_past_due', (l ->> 'days_past_due')::int,
                                 'ledger_group_id', v_group));
    END IF;
  END LOOP;
  RETURN public._special_advance_provision_review_json(v_id) || jsonb_build_object('replayed', false);
END $$;

-- ── Write-off (one step) ───────────────────────────────────────────────────
CREATE FUNCTION public._special_advance_write_off_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(w) || jsonb_build_object('advance_reference', a.reference,
    'recorded_by_name', NULLIF(btrim(rp.full_name), ''))
    FROM public.special_advance_write_offs w
    JOIN public.special_advances a ON a.id = w.advance_id
    LEFT JOIN public.profiles rp ON rp.id = w.recorded_by
   WHERE w.id = p_id;
$$;

-- p_request: {reason, proof_path, idempotency_key, expected_gross_amount}. The CFO's one authorised action (decision
-- 2026-11-03): writes off the whole gross outstanding now, using the allowance held, posts once (key
-- 'special_advance:write_off:<id>') and writes the append-only record, all in one transaction. expected_gross_amount
-- (optional, the balance the CFO saw): if the balance moved since, nothing posts (WRITE_OFF_STALE).
CREATE FUNCTION public.special_advance_write_off(p_id uuid, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_reason text := NULLIF(btrim(COALESCE(p_request ->> 'reason', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_request ->> 'proof_path', '')), '');
  v_expected text := NULLIF(btrim(COALESCE(p_request ->> 'expected_gross_amount', '')), '');
  a public.special_advances%ROWTYPE;
  e public.special_advance_write_offs%ROWTYPE;
  v_gross bigint;
  v_held bigint;
  v_net bigint;
  v_id uuid := gen_random_uuid();
  v_ref text;
  v_today date := public._special_advance_kampala_today();
  v_src jsonb;
  v_legs jsonb;
  v_desc text;
  v_group uuid;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_expected IS NOT NULL AND v_expected !~ '^[0-9]{1,15}$' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["expected_gross_amount"]';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:write_off:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_write_offs WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND e.proof_path = v_proof AND e.reason = v_reason THEN
      RETURN public._special_advance_write_off_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 20 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Explain the write-off in 20 to 1000 characters';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_WRITABLE_OFF' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  v_gross := (public._special_advance_position(a.id) ->> 'outstanding')::bigint;
  v_held := public._special_advance_allowance_held(a.id);
  IF v_gross <= 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_WRITABLE_OFF' USING ERRCODE = '22023', DETAIL = 'nothing outstanding';
  END IF;
  IF v_expected IS NOT NULL AND v_expected::bigint <> v_gross THEN
    RAISE EXCEPTION 'WRITE_OFF_STALE' USING ERRCODE = '40001',
      DETAIL = jsonb_build_object('expected_gross_amount', v_expected::bigint, 'gross_amount', v_gross)::text;
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D9: the evidence that the balance cannot be collected
  v_net := v_gross - v_held;

  v_ref := 'SAW-' || lpad(nextval('public.special_advance_write_off_seq')::text, 6, '0');
  v_desc := format('Special Advance %s write-off %s', a.reference, v_ref);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_write_offs', 'source_id', v_id,
                              'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  v_legs := jsonb_build_array(
    v_src || jsonb_build_object('direction', 'cash_in', 'amount', v_gross, 'category', 'special_advance_write_off',
                                'description', v_desc || ': gross receivable written off'));
  IF v_held > 0 THEN
    v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', v_held,
                                'category', 'special_advance_impairment_allowance', 'description', v_desc || ': allowance used'));
  END IF;
  IF v_net > 0 THEN
    v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', v_net,
                                'category', 'special_advance_write_off_loss', 'description', v_desc || ': loss not covered by the allowance'));
  ELSIF v_net < 0 THEN
    v_legs := v_legs || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', -v_net,
                                'category', 'special_advance_impairment_charge', 'description', v_desc || ': excess allowance released'));
  END IF;
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:write_off:' || v_id::text, false);

  INSERT INTO public.special_advance_write_offs (id, reference, advance_id, gross_amount, allowance_released, net_loss, reason,
                                                 proof_path, idempotency_key, ledger_group_id, recorded_by)
  VALUES (v_id, v_ref, a.id, v_gross, v_held, v_net, v_reason, v_proof, v_key, v_group, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'write_off_posted', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('write_off_id', v_id, 'gross_amount', v_gross, 'allowance_released', v_held,
                             'net_loss', v_net, 'ledger_group_id', v_group));
  PERFORM set_config('special_advance.write_off', v_id::text, true);
  UPDATE public.special_advances SET status = 'written_off' WHERE id = a.id;
  PERFORM set_config('special_advance.write_off', '', true);
  RETURN public._special_advance_write_off_json(v_id) || jsonb_build_object('replayed', false);
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
  SELECT * INTO w FROM public.special_advance_write_offs WHERE advance_id = a.id;
  BEGIN v_amount := (p_recovery ->> 'amount')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  BEGIN v_date := (p_recovery ->> 'received_date')::date; EXCEPTION WHEN others THEN v_date := NULL; END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> trunc(v_amount) THEN v_errs := v_errs || 'amount'::text; END IF;
  IF v_date IS NULL OR v_date > v_today OR v_date < (w.recorded_at AT TIME ZONE 'Africa/Kampala')::date THEN
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
    'corrections', COALESCE((SELECT jsonb_agg(public._special_advance_correction_json(c.id) ORDER BY c.recorded_at)
      FROM public.special_advance_corrections c WHERE c.advance_id = p_id), '[]'::jsonb),
    'allowance_held', public._special_advance_allowance_held(p_id),
    'provision', public._special_advance_provision_line(p_id, NULL),
    'provision_history', COALESCE((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('review', v2.reference,
                                                                                       'recorded_at', v2.recorded_at) ORDER BY v2.recorded_at, v2.reference)
      FROM public.special_advance_provision_lines l JOIN public.special_advance_provision_reviews v2 ON v2.id = l.review_id
     WHERE l.advance_id = p_id), '[]'::jsonb),
    'write_offs', COALESCE((SELECT jsonb_agg(public._special_advance_write_off_json(w.id) ORDER BY w.recorded_at)
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
REVOKE ALL ON FUNCTION public._special_advance_allowance_held(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_provision_line(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_provision_proposal(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_provision_review_json(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_write_off_json(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.special_advance_provision_preview(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_post_provision_review(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_write_off(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_record_recovery(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_provision_preview(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_post_provision_review(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_write_off(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_record_recovery(uuid, jsonb) TO authenticated;

DO $post$
BEGIN
  IF has_function_privilege('authenticated', 'public._special_advance_eligibility(text,uuid,text,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._special_advance_check_proof(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._special_advance_audit()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.special_advance_statement(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.special_advance_reconciliation()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.special_advance_reconciliation()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.special_advance_write_offs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.special_advance_provision_reviews', 'INSERT')
     OR has_function_privilege('authenticated', 'public._special_advance_provision_proposal(jsonb)', 'EXECUTE')
     OR has_table_privilege('anon', 'public.special_advance_recoveries', 'SELECT') THEN
    RAISE EXCEPTION 'postcondition failed: a Special Advances privilege changed; nothing was changed';
  END IF;
END
$post$;

RESET lock_timeout;
