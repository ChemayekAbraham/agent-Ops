-- 2026-10-27: Special Advances, Phase 4: payout, repayment and reconciliation. NOT APPLIED. Production apply needs
-- explicit CFO approval; it changes the accounting policy (new account A24, six ledger_account_map rows, six allowlisted
-- categories). It changes no existing mapping row, account, category, posting function or advance product.
-- A20-A23 already exist in production (A20 = Agent Advance Registration Fees Receivable, since 2026-09-26) and are
-- left exactly as they are; Special Advances uses A24, the first free code (audit 2026-10-27).
--
-- CFO decisions 2026-10-27:
--   * books: new account A24 Special Advances Receivable (keeps A10's tie to agent_advances intact);
--   * payout: a Welile borrower is credited to their WITHDRAWABLE wallet (withdrawn through the normal controlled
--     flow); an external borrower is paid off-platform (mobile money / bank transfer) by the CFO, recorded with its
--     reference and posted from company cash (A1);
--   * repayments are recorded by the CFO only (reference required; no wallet sweeps);
--   * no late fee: an unpaid instalment past its due date is reported overdue, nothing is charged;
--   * an overpayment is refused (a repayment may not exceed what is outstanding);
--   * early settlement pays the full agreed total (no discount).
-- Fees are recognised at payout, as existing advances do: the receivable rises by principal + access fee +
-- registration fee and revenue (R1) by the two fees; a repayment then only reduces the receivable.
--
-- Ledger groups (all via create_ledger_transaction, idempotency-keyed, raw cash_in = cash_out, mapped DR = CR):
--   payout, Welile:   wallet  special_advance_credit (withdrawable) cash_in  P   -> CR L1
--                     platform special_advance_receivable           cash_out P   -> DR A24
--   payout, external: platform special_advance_payout_cash          cash_in  P   -> CR A1
--                     platform special_advance_receivable           cash_out P   -> DR A24
--   fees (same group as the payout, legs only when > 0):
--                     platform special_advance_receivable           cash_out F   -> DR A24
--                     platform special_advance_fee_revenue          cash_in  F   -> CR R1
--   repayment:        platform special_advance_repayment_received   cash_in  X   -> DR A1
--                     platform special_advance_repayment            cash_out X   -> CR A24
-- None of these categories or group shapes is captured by a resolver override (overrides key on other categories or
-- on 2-wallet-leg / A2 shapes), and none is a treasury category.
--
-- Preflight refuses (nothing changed) unless: Phase 3 is applied; A24 and the six categories are new; both category
-- validators consult ledger_category_allowlist(); the live allowlist is exactly the audited production definition
-- (md5 of its body 736744d355fe913acfcc0593204613a6, search_path=public, extensions, pg_temp) and has the expected
-- `SELECT <expr>;` form. It is extended in place, keeping its search_path setting, and every previous category is
-- verified to remain.
-- Repayment cash is posted to A1 (bank / mobile money). Physical cash (A5) is not accepted: methods are mobile_money and
-- bank_transfer only, pending a decision.
-- Staff MFA (PROPOSAL, needs CFO confirmation; docs/special-advances/phase4-cfo-decisions.md): approval, payout and
-- repayment recording require a session verified with the authenticator app (aal2), independent of the global
-- staff_mfa_config mode. Reject, cancel and the read-only views are unchanged.
-- Rollback: supabase/rollbacks/20261028153000_special_advances_payout_repayment.rollback.sql (refuses once anything
-- has been posted).
-- Tests: src/test/specialAdvancePayout.test.ts (PGlite, with the repo's create_ledger_transaction verbatim).

SET lock_timeout = '5s';
DO $pre$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.special_advance_create(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances functions (20261028152000) are not applied; nothing was changed';
  END IF;
  IF to_regclass('public.special_advance_repayments') IS NOT NULL OR to_regprocedure('public.special_advance_disburse(uuid,timestamptz,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances payout objects already exist; nothing was changed';
  END IF;
  IF to_regclass('public.ledger_account_catalog') IS NULL OR to_regclass('public.ledger_account_map') IS NULL
     OR to_regprocedure('public.create_ledger_transaction(jsonb,text,boolean)') IS NULL
     OR to_regprocedure('public.ledger_category_allowlist()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: a ledger object this phase uses is missing; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_catalog WHERE code = 'A24') THEN
    RAISE EXCEPTION 'precondition failed: account A24 already exists; nothing was changed';
  END IF;
  -- The allowlist must be exactly the definition audited on 2026-10-27, so it is extended knowingly and its security
  -- setting is carried over unchanged.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM '736744d355fe913acfcc0593204613a6'
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=public, extensions, pg_temp'] THEN
    RAISE EXCEPTION 'precondition failed: ledger_category_allowlist() differs from the audited production definition; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category LIKE 'special\_advance\_%')
     OR public.ledger_category_allowlist() && ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                                                     'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment'] THEN
    RAISE EXCEPTION 'precondition failed: a Special Advances ledger category already exists; nothing was changed';
  END IF;
  -- Both validators must read the allowlist, or a new category could be refused at insert.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.validate_ledger_category(text)'::regprocedure;
  IF v_src IS NULL OR v_src !~ 'ledger_category_allowlist\(\)' THEN
    RAISE EXCEPTION 'precondition failed: validate_ledger_category(text) does not consult ledger_category_allowlist(); nothing was changed';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.validate_ledger_category()'::regprocedure;
  IF v_src IS NOT NULL AND v_src !~ 'validate_ledger_category\(|ledger_category_allowlist\(\)' THEN
    RAISE EXCEPTION 'precondition failed: the validate_ledger_category trigger checks its own list, not the allowlist; nothing was changed';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  IF v_src !~* '^\s*select\s.*;\s*$' OR v_src ~ '\$' THEN
    RAISE EXCEPTION 'precondition failed: ledger_category_allowlist() is not a single SELECT expression; nothing was changed';
  END IF;
END
$pre$;

-- ── Chart of accounts, mapping, allowlist ──────────────────────────────────────────────────────────
INSERT INTO public.ledger_account_catalog (code, label, section, nature, sort_order)
VALUES ('A24', 'Special Advances Receivable', 'current_asset', 'asset',
        COALESCE((SELECT sort_order + 1 FROM public.ledger_account_catalog WHERE code = 'A23'), 100));

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('wallet', 'special_advance_credit', 'withdrawable', 'L1', 'cash_out', 'Special Advance paid out to a Welile borrower''s withdrawable wallet (owed to them)'),
  ('platform', 'special_advance_receivable', NULL, 'A24', 'cash_out', 'Special Advance receivable: principal at payout, plus access and registration fees recognised at payout'),
  ('platform', 'special_advance_payout_cash', NULL, 'A1', 'cash_out', 'Special Advance paid out off-platform to an external borrower (company cash leaves)'),
  ('platform', 'special_advance_fee_revenue', NULL, 'R1', 'cash_out', 'Special Advance access / registration fee recognised at payout'),
  ('platform', 'special_advance_repayment_received', NULL, 'A1', 'cash_in', 'Special Advance repayment received into company cash (recorded by the CFO)'),
  ('platform', 'special_advance_repayment', NULL, 'A24', 'cash_in', 'Special Advance repayment reduces the receivable');

-- Extend the allowlist in place: the live body is kept verbatim and the new categories are appended to its result.
-- CREATE OR REPLACE resets a function's SET options, so the production search_path setting is restated explicitly
-- (it was verified in the preflight) and re-checked afterwards; grants and owner are kept by CREATE OR REPLACE.
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
  SELECT (%s) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[];
$body$$f$, v_expr);
  v_after := public.ledger_category_allowlist();
  IF NOT (v_after @> v_before)
     OR cardinality(v_after) <> cardinality(v_before) + 6
     OR NOT (v_after @> ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                              'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']) THEN
    RAISE EXCEPTION 'allowlist check failed: previous categories not all preserved, or new ones missing';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=public, extensions, pg_temp']
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'allowlist check failed: the search_path setting or volatility was not preserved';
  END IF;
END
$allow$;

-- ── Payout record on the agreement ─────────────────────────────────────────────────────────────────
ALTER TABLE public.special_advances
  ADD COLUMN payout_method text CHECK (payout_method IS NULL OR payout_method IN ('wallet', 'mobile_money', 'bank_transfer')),
  ADD COLUMN payout_reference text CHECK (payout_reference IS NULL OR length(btrim(payout_reference)) BETWEEN 3 AND 100),
  ADD COLUMN payout_ledger_group_id uuid,
  ADD CONSTRAINT special_advances_payout_record CHECK (
    status NOT IN ('disbursed', 'settled')
    OR (payout_method IS NOT NULL AND payout_ledger_group_id IS NOT NULL
        AND (payout_method = 'wallet') = (borrower_kind = 'welile_user')
        AND (payout_method = 'wallet' OR payout_reference IS NOT NULL)));

-- The payout fields are written once, in the payout transition, and never again.
CREATE FUNCTION public._special_advance_guard_payout_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.payout_method, NEW.payout_reference, NEW.payout_ledger_group_id)
     IS DISTINCT FROM (OLD.payout_method, OLD.payout_reference, OLD.payout_ledger_group_id)
     AND NOT (OLD.status = 'approved' AND NEW.status = 'disbursed') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'payout record';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER special_advances_guard_payout_fields BEFORE UPDATE ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_payout_fields();

-- ── Staff MFA for the money-moving actions (PROPOSAL: needs CFO confirmation) ───────────────────────────────
-- Approval, payout and repayment recording need a session verified with the authenticator app (JWT aal = aal2),
-- whatever the global staff_mfa_config mode is (production 2026-10-27: 'shadow'). This only adds a requirement: the CFO
-- role check, issuance switch, version checks and everything else stay. Reject, cancel and the read-only views are
-- unchanged. As at 2026-10-27 no CFO has an authenticator enrolled, so these actions stay impossible until a CFO enrols
-- (issuance is switched off in any case). A call with no signed-in user is not a client call (owner / service role
-- maintenance), which bypasses every check anyway; the CFO-only functions always run with a signed-in user.
CREATE FUNCTION public._special_advance_require_mfa()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND COALESCE(auth.jwt() ->> 'aal', 'aal1') IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE = '42501',
      DETAIL = 'Approving, paying out or recording a repayment needs a session verified with your authenticator app';
  END IF;
END $$;

-- The Phase 3 approval function is not replaced: the approval and payout transitions themselves are guarded here.
CREATE FUNCTION public._special_advance_guard_mfa()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved', 'disbursed') THEN
    PERFORM public._special_advance_require_mfa();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER special_advances_require_mfa BEFORE UPDATE ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_mfa();

-- ── Repayments (append-only) ───────────────────────────────────────────────────────────────────────
CREATE TABLE public.special_advance_repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  amount bigint NOT NULL CHECK (amount > 0),
  received_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('mobile_money', 'bank_transfer')),
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 3 AND 100),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  ledger_group_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
-- The same external transaction can never be recorded twice.
CREATE UNIQUE INDEX special_advance_repayments_reference_uq ON public.special_advance_repayments (method, upper(btrim(reference)));
CREATE INDEX special_advance_repayments_advance_idx ON public.special_advance_repayments (advance_id, received_date);

CREATE TABLE public.special_advance_repayment_allocations (
  repayment_id uuid NOT NULL REFERENCES public.special_advance_repayments(id),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  instalment_number integer NOT NULL CHECK (instalment_number >= 1),
  access_fee bigint NOT NULL CHECK (access_fee >= 0),
  registration_fee bigint NOT NULL CHECK (registration_fee >= 0),
  principal bigint NOT NULL CHECK (principal >= 0),
  PRIMARY KEY (repayment_id, instalment_number),
  CONSTRAINT special_advance_allocation_positive CHECK (access_fee + registration_fee + principal > 0)
);

CREATE TRIGGER special_advance_repayments_append_only BEFORE UPDATE OR DELETE ON public.special_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();
CREATE TRIGGER special_advance_repayment_allocations_append_only BEFORE UPDATE OR DELETE ON public.special_advance_repayment_allocations
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();

-- At commit: each repayment is fully allocated, and no instalment component is ever paid beyond what was agreed.
CREATE FUNCTION public._special_advance_verify_repayments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_adv uuid := (to_jsonb(NEW) ->> 'advance_id')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments r
              WHERE r.advance_id = v_adv
                AND r.amount <> COALESCE((SELECT sum(x.access_fee + x.registration_fee + x.principal)
                                            FROM public.special_advance_repayment_allocations x WHERE x.repayment_id = r.id), 0)) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_instalments i
               LEFT JOIN (SELECT instalment_number, sum(access_fee) a, sum(registration_fee) g, sum(principal) p
                            FROM public.special_advance_repayment_allocations WHERE advance_id = v_adv GROUP BY instalment_number) s
                 ON s.instalment_number = i.number
              WHERE i.advance_id = v_adv
                AND (COALESCE(s.a, 0) > i.access_fee OR COALESCE(s.g, 0) > i.registration_fee OR COALESCE(s.p, 0) > i.principal))
     OR EXISTS (SELECT 1 FROM public.special_advance_repayment_allocations x
                 WHERE x.advance_id = v_adv
                   AND NOT EXISTS (SELECT 1 FROM public.special_advance_instalments i WHERE i.advance_id = v_adv AND i.number = x.instalment_number)) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_OVERALLOCATED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER special_advance_repayments_verify AFTER INSERT ON public.special_advance_repayments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._special_advance_verify_repayments();
CREATE CONSTRAINT TRIGGER special_advance_repayment_allocations_verify AFTER INSERT ON public.special_advance_repayment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._special_advance_verify_repayments();

REVOKE ALL ON public.special_advance_repayments, public.special_advance_repayment_allocations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.special_advance_repayments, public.special_advance_repayment_allocations TO authenticated;
GRANT ALL ON public.special_advance_repayments, public.special_advance_repayment_allocations TO service_role;
ALTER TABLE public.special_advance_repayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_repayment_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY special_advance_repayments_select ON public.special_advance_repayments FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_repayment_allocations_select ON public.special_advance_repayment_allocations FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_repayments AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_repayment_allocations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- ── Read model: what is paid, outstanding and overdue per instalment ──────────────────────────────
CREATE FUNCTION public._special_advance_position(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH inst AS (
    SELECT i.number, i.due_date, i.amount, i.access_fee, i.registration_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.g, 0) AS paid_registration, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT instalment_number, sum(access_fee) a, sum(registration_fee) g, sum(principal) p
                   FROM public.special_advance_repayment_allocations WHERE advance_id = p_id GROUP BY instalment_number) s
        ON s.instalment_number = i.number
     WHERE i.advance_id = p_id
  ), rows AS (
    SELECT *, amount - paid_access - paid_registration - paid_principal AS outstanding FROM inst
  )
  SELECT jsonb_build_object(
    'total_repayable', (SELECT total_repayable FROM public.special_advances WHERE id = p_id),
    'total_paid', COALESCE((SELECT sum(paid_access + paid_registration + paid_principal) FROM rows), 0),
    'outstanding', COALESCE((SELECT sum(outstanding) FROM rows), 0),
    'outstanding_access_fee', COALESCE((SELECT sum(access_fee - paid_access) FROM rows), 0),
    'outstanding_registration_fee', COALESCE((SELECT sum(registration_fee - paid_registration) FROM rows), 0),
    'outstanding_principal', COALESCE((SELECT sum(principal - paid_principal) FROM rows), 0),
    'overdue_amount', COALESCE((SELECT sum(outstanding) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0), 0),
    'overdue_instalments', (SELECT count(*) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0),
    'instalments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', number, 'due_date', due_date, 'amount', amount,
        'paid', paid_access + paid_registration + paid_principal, 'outstanding', outstanding,
        'status', CASE WHEN outstanding = 0 THEN 'paid'
                       WHEN due_date IS NULL THEN 'not_due'
                       WHEN due_date < public._special_advance_kampala_today() THEN 'overdue'
                       WHEN outstanding < amount THEN 'part_paid' ELSE 'due' END) ORDER BY number) FROM rows), '[]'::jsonb));
$$;

-- ── Payout (approval and payout are separate steps) ───────────────────────────────────────────────
-- p_payout: {payout_date, method, reference}. Welile borrower: method 'wallet' (credited to their withdrawable
-- wallet); external: 'mobile_money' or 'bank_transfer' with the transaction reference. Duplicate-safe: the row lock,
-- the version check and the per-advance ledger key ('special_advance:<id>:payout') mean a payout can post only once.
CREATE FUNCTION public.special_advance_disburse(p_id uuid, p_expected_updated_at timestamptz, p_payout jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
  eb public.special_advance_external_borrowers%ROWTYPE;
  v_date date;
  v_method text := p_payout ->> 'method';
  v_ref text := NULLIF(btrim(COALESCE(p_payout ->> 'reference', '')), '');
  v_elig text[];
  v_legs jsonb;
  v_desc text;
  v_group uuid;
  v_src jsonb;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF a.status = 'disbursed' AND a.payout_ledger_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_ALREADY_PAID_OUT' USING ERRCODE = '22023';
  END IF;
  IF a.status <> 'approved' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_APPROVED' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF NOT public._special_advance_issuance_enabled() THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCES_DISABLED' USING ERRCODE = '55000';
  END IF;
  BEGIN
    v_date := (p_payout ->> 'payout_date')::date;
  EXCEPTION WHEN others THEN v_date := NULL;
  END;
  IF v_date IS NULL OR v_date > v_today OR v_date < (a.approved_at AT TIME ZONE 'Africa/Kampala')::date THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["payout_date"]';
  END IF;
  IF a.borrower_kind = 'welile_user' THEN
    IF v_method IS DISTINCT FROM 'wallet' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["method"]';
    END IF;
    IF a.borrower_user_id = v_actor THEN
      RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_method IS NULL OR v_method NOT IN ('mobile_money', 'bank_transfer') OR v_ref IS NULL OR length(v_ref) NOT BETWEEN 3 AND 100 THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["method","reference"]';
    END IF;
  END IF;
  -- the borrower may have become ineligible since approval
  SELECT * INTO eb FROM public.special_advance_external_borrowers WHERE id = a.external_borrower_id;
  v_elig := public._special_advance_eligibility(a.borrower_kind, a.borrower_user_id, eb.phone, eb.national_id, eb.registration_number, a.id);
  IF cardinality(v_elig) > 0 THEN
    RAISE EXCEPTION 'BORROWER_NOT_ELIGIBLE' USING ERRCODE = '22023', DETAIL = to_jsonb(v_elig)::text;
  END IF;

  v_desc := format('Special Advance %s payout', a.reference);
  v_src := jsonb_build_object('source_table', 'special_advances', 'source_id', a.id, 'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_date::timestamp AT TIME ZONE 'Africa/Kampala'));
  v_legs := jsonb_build_array(
    v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', a.principal,
                                'category', 'special_advance_receivable', 'description', v_desc || ': principal receivable'));
  IF a.borrower_kind = 'welile_user' THEN
    v_legs := v_legs || (v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', a.principal,
                                'category', 'special_advance_credit', 'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable',
                                'recipient_type', 'user', 'description', v_desc || ' to the borrower''s wallet'));
  ELSE
    v_legs := v_legs || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', a.principal,
                                'category', 'special_advance_payout_cash', 'description',
                                format('%s by %s, ref %s', v_desc, replace(v_method, '_', ' '), v_ref)));
  END IF;
  IF a.access_fee > 0 THEN
    v_legs := v_legs
      || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', a.access_fee,
                                      'category', 'special_advance_receivable', 'description', v_desc || ': access fee receivable'))
      || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', a.access_fee,
                                      'category', 'special_advance_fee_revenue', 'description', v_desc || ': access fee'));
  END IF;
  IF a.registration_fee > 0 THEN
    v_legs := v_legs
      || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', a.registration_fee,
                                      'category', 'special_advance_receivable', 'description', v_desc || ': registration fee receivable'))
      || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', a.registration_fee,
                                      'category', 'special_advance_fee_revenue', 'description', v_desc || ': registration fee'));
  END IF;

  -- one key per advance: a second payout can never post, whatever key the caller sends
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:' || a.id::text || ':payout', false);

  UPDATE public.special_advances
     SET status = 'disbursed', payout_date = v_date, disbursed_by = v_actor, disbursed_at = clock_timestamp(),
         payout_method = v_method, payout_reference = v_ref, payout_ledger_group_id = v_group
   WHERE id = a.id;
  RETURN public._special_advance_json(a.id) || jsonb_build_object('position', public._special_advance_position(a.id));
END $$;

-- ── Repayment (recorded by the CFO) ───────────────────────────────────────────────────────────────
-- p_repayment: {amount, received_date, method, reference, idempotency_key, note}. Allocated to the oldest unpaid
-- instalment first, each in the order access fee -> registration fee -> principal (no late fee). An amount above what
-- is outstanding is refused. Paying everything settles the advance (early settlement pays the full agreed total).
CREATE FUNCTION public.special_advance_record_repayment(p_id uuid, p_repayment jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_key text := btrim(COALESCE(p_repayment ->> 'idempotency_key', ''));
  v_amount numeric;
  v_date date;
  v_method text := p_repayment ->> 'method';
  v_ref text := NULLIF(btrim(COALESCE(p_repayment ->> 'reference', '')), '');
  v_note text := NULLIF(btrim(COALESCE(p_repayment ->> 'note', '')), '');
  a public.special_advances%ROWTYPE;
  e public.special_advance_repayments%ROWTYPE;
  v_errs text[] := '{}';
  v_pos jsonb;
  v_left bigint;
  v_rep uuid := gen_random_uuid();
  v_group uuid;
  i record;
  v_split jsonb;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:repayment:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_repayments WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND COALESCE(p_repayment ->> 'amount', '') ~ '^[0-9]+$'
       AND e.amount = (p_repayment ->> 'amount')::bigint
       AND e.reference = v_ref AND e.method = v_method THEN
      RETURN public._special_advance_json(p_id) || jsonb_build_object('position', public._special_advance_position(p_id), 'replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_REPAYABLE' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;

  BEGIN v_amount := (p_repayment ->> 'amount')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  BEGIN v_date := (p_repayment ->> 'received_date')::date; EXCEPTION WHEN others THEN v_date := NULL; END;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> trunc(v_amount) THEN v_errs := v_errs || 'amount'::text; END IF;
  IF v_date IS NULL OR v_date > v_today OR v_date < a.payout_date THEN v_errs := v_errs || 'received_date'::text; END IF;
  IF v_method IS NULL OR v_method NOT IN ('mobile_money', 'bank_transfer') THEN v_errs := v_errs || 'method'::text; END IF;
  IF v_ref IS NULL OR length(v_ref) NOT BETWEEN 3 AND 100 THEN v_errs := v_errs || 'reference'::text; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN v_errs := v_errs || 'note'::text; END IF;
  IF cardinality(v_errs) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = to_jsonb(v_errs)::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments r WHERE r.method = v_method AND upper(btrim(r.reference)) = upper(v_ref)) THEN
    RAISE EXCEPTION 'REPAYMENT_REFERENCE_ALREADY_RECORDED' USING ERRCODE = '23505';
  END IF;

  v_pos := public._special_advance_position(a.id);
  IF v_amount > (v_pos ->> 'outstanding')::bigint THEN
    RAISE EXCEPTION 'OVERPAYMENT_REFUSED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('outstanding', (v_pos ->> 'outstanding')::bigint)::text;
  END IF;

  v_group := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_amount::bigint,
                       'category', 'special_advance_repayment_received', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX', 'transaction_date', (v_date::timestamp AT TIME ZONE 'Africa/Kampala'),
                       'description', format('Special Advance %s repayment by %s, ref %s', a.reference, replace(v_method, '_', ' '), v_ref)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_amount::bigint,
                       'category', 'special_advance_repayment', 'source_table', 'special_advance_repayments', 'source_id', v_rep,
                       'reference_id', a.reference, 'currency', 'UGX', 'transaction_date', (v_date::timestamp AT TIME ZONE 'Africa/Kampala'),
                       'description', format('Special Advance %s receivable reduced', a.reference))),
    'special_advance:repayment:' || v_key, false);

  INSERT INTO public.special_advance_repayments (id, advance_id, amount, received_date, method, reference, note, idempotency_key,
                                                 ledger_group_id, recorded_by)
  VALUES (v_rep, a.id, v_amount::bigint, v_date, v_method, v_ref, v_note, v_key, v_group, v_actor);

  v_left := v_amount::bigint;
  FOR i IN
    SELECT x.number,
           x.access_fee - COALESCE(s.a, 0) AS access_fee, x.registration_fee - COALESCE(s.g, 0) AS registration_fee,
           x.principal - COALESCE(s.p, 0) AS principal
      FROM public.special_advance_instalments x
      LEFT JOIN (SELECT instalment_number, sum(access_fee) a, sum(registration_fee) g, sum(principal) p
                   FROM public.special_advance_repayment_allocations WHERE advance_id = a.id GROUP BY instalment_number) s
        ON s.instalment_number = x.number
     WHERE x.advance_id = a.id
     ORDER BY x.number
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN i.access_fee + i.registration_fee + i.principal = 0;
    v_split := public._special_advance_allocate(jsonb_build_object('late_fee', 0, 'access_fee', i.access_fee,
                 'registration_fee', i.registration_fee, 'principal', i.principal), v_left);
    INSERT INTO public.special_advance_repayment_allocations (repayment_id, advance_id, instalment_number, access_fee, registration_fee, principal)
    VALUES (v_rep, a.id, i.number, (v_split ->> 'access_fee')::bigint, (v_split ->> 'registration_fee')::bigint, (v_split ->> 'principal')::bigint);
    v_left := (v_split ->> 'excess')::bigint;
  END LOOP;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF (public._special_advance_position(a.id) ->> 'outstanding')::bigint = 0 THEN
    UPDATE public.special_advances SET status = 'settled', settled_at = clock_timestamp() WHERE id = a.id;
  END IF;
  RETURN public._special_advance_json(a.id) || jsonb_build_object('position', public._special_advance_position(a.id), 'replayed', false);
END $$;

CREATE FUNCTION public.special_advance_statement(p_id uuid)
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
        'note', r.note, 'recorded_by', r.recorded_by, 'recorded_at', r.recorded_at, 'ledger_group_id', r.ledger_group_id) ORDER BY r.recorded_at)
      FROM public.special_advance_repayments r WHERE r.advance_id = p_id), '[]'::jsonb));
END $$;

-- Ties the subledger to the ledger. A24 is a new account that no resolver override touches, so its balance is
-- read from base mapping: DR - CR of every leg mapped to A24.
CREATE FUNCTION public.special_advance_reconciliation()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ledger numeric;
  v_sub numeric;
  v_rows jsonb;
BEGIN
  PERFORM public._special_advance_require_cfo();
  SELECT COALESCE(sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END), 0) INTO v_ledger
    FROM public.general_ledger gl
    JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
                                     AND (m.wallet_bucket IS NULL OR m.wallet_bucket = gl.wallet_bucket)
   WHERE gl.category LIKE 'special\_advance\_%';
  SELECT COALESCE(sum((public._special_advance_position(a.id) ->> 'outstanding')::numeric), 0) INTO v_sub
    FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled');
  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'reference'), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object('reference', a.reference, 'status', a.status,
             'subledger_outstanding', (public._special_advance_position(a.id) ->> 'outstanding')::numeric,
             'ledger_balance', COALESCE((
               SELECT sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END)
                 FROM public.general_ledger gl
                 JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
                WHERE (gl.source_table = 'special_advances' AND gl.source_id = a.id)
                   OR (gl.source_table = 'special_advance_repayments' AND gl.source_id IN (SELECT r.id FROM public.special_advance_repayments r WHERE r.advance_id = a.id))), 0)) AS x
      FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled')) t
   WHERE (x ->> 'subledger_outstanding')::numeric <> (x ->> 'ledger_balance')::numeric;
  RETURN jsonb_build_object('a24_ledger_balance', v_ledger, 'subledger_outstanding', v_sub,
                            'difference', v_ledger - v_sub, 'balanced', v_ledger = v_sub AND jsonb_array_length(v_rows) = 0,
                            'mismatched_advances', v_rows);
END $$;

-- ── Privileges ─────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._special_advance_guard_payout_fields() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_verify_repayments() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_position(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_require_mfa() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_guard_mfa() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.special_advance_disburse(uuid, timestamptz, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_record_repayment(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_statement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_disburse(uuid, timestamptz, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_record_repayment(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_statement(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_reconciliation() TO authenticated;

RESET lock_timeout;
