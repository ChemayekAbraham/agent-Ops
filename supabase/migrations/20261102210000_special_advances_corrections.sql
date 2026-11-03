-- 2026-11-02: Special Advances readiness, Phase B: corrections. Production apply needs explicit CFO approval.
-- CFO decisions D11 (2026-11-02):
--   D11a a correction posts NEW ledger legs: the same special_advance_* categories in the opposite direction, under
--        source_table 'special_advance_corrections' and linked to the original. No new account, mapping or allowlist
--        entry; nothing already posted is edited or deleted.
--   D11b maker-checker: one enabled CFO requests, a DIFFERENT enabled CFO approves or rejects (both with a session
--        verified by the authenticator app, aal2). Nothing posts until approval. The requester may withdraw.
--   D11c scope: (1) reverse an erroneous repayment (any paid-out advance; a settled one reopens);
--        (2) reverse an external payout recorded in error, once every repayment on it has been reversed (the advance
--        ends 'reversed'). A payout to a Welile wallet cannot be reversed here (it would take money from a wallet).
--   D11d every correction carries a reason (20-1000 characters) and an archived proof file (same rules as D1/D2:
--        private bucket, this advance's folder, must exist, used once).
--
-- Ledger (create_ledger_transaction, one fixed key per correction: 'special_advance:correction:<id>'):
--   repayment reversal: platform special_advance_repayment_received cash_out X -> CR A1
--                       platform special_advance_repayment          cash_in  X -> DR A24
--   payout reversal:    platform special_advance_payout_cash        cash_out P -> DR A1
--                       platform special_advance_receivable         cash_in  P -> CR A24
--                       per fee F > 0: special_advance_fee_revenue cash_out F -> DR R1; special_advance_receivable cash_in F -> CR A24
--   Each group nets to zero raw and balances on the existing mapping; no resolver override or synthetic leg keys on
--   these categories (read-only check of sofp_ledger_legs, 2026-11-02).
--
-- Records: special_advance_corrections (request -> approved | rejected | withdrawn, decided once). An approved
-- repayment reversal stamps special_advance_repayments.reversed_by_correction once (the only change ever allowed to a
-- repayment row); its allocations then stop counting, and its provider reference may be recorded again (e.g. against
-- the right advance). Status edges added: settled -> disbursed (reopened) and disbursed -> reversed (external only).
-- Events: correction_requested / _approved / _rejected / _withdrawn, reopened, reversed.
--
-- Replaces 8 Special Advances functions; the preflight refuses (nothing changed) unless each is exactly the
-- production definition read on 2026-11-02 (md5 of its body). CREATE OR REPLACE keeps owners and privileges.
-- Rollback: supabase/rollbacks/20261102210000_special_advances_corrections.rollback.sql (refuses once any correction
-- exists). Tests: src/test/specialAdvanceCorrections.test.ts. TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.special_advance_corrections') IS NOT NULL
     OR to_regprocedure('public.special_advance_request_correction(uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances corrections already exist; nothing was changed';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public._special_advance_guard_update()', '8277f5c1c14aa61f7a028729f41eac54'),
      ('public._special_advance_audit()', '9d7a51d617ceffbe8607074c518c9dd3'),
      ('public._special_advance_verify_repayments()', '5c5d5ecdf99e704b7d37516d43ed0095'),
      ('public._special_advance_check_proof(uuid,text)', '36340f50232b5e5c1c5b58137d0aa2b8'),
      ('public.special_advance_record_repayment(uuid,jsonb)', 'f497ebdd9ad89fc9c9d8a4672e9d716b'),
      ('public.special_advance_statement(uuid)', '91104eb0097c7f614022f07aca13025d'),
      ('public.special_advance_reconciliation()', '977598518dd47c483921aa5ba2cb42f0'),
      ('public._special_advance_position(uuid)', 'b2515026024dcd7ff7b2744f58d35b27')) v(sig, md5)
  LOOP
    IF to_regprocedure(r.sig) IS NULL
       OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'precondition failed: % differs from the production definition of 2026-11-02 (Phase 4 + Phase A); nothing was changed', r.sig;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.special_advances'::regclass
        AND conname IN ('special_advances_status_check', 'special_advances_approved_fields', 'special_advances_disbursed_fields',
                        'special_advances_payout_record')) <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.special_advance_events'::regclass AND conname = 'special_advance_events_event_type_check')
     OR to_regclass('public.special_advance_repayments_reference_uq') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.special_advance_repayments'::regclass AND tgname = 'special_advance_repayments_append_only') THEN
    RAISE EXCEPTION 'precondition failed: a Special Advances constraint, index or trigger this phase replaces is missing; nothing was changed';
  END IF;
END
$pre$;

-- ── Status and event values ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.special_advances
  DROP CONSTRAINT special_advances_status_check,
  ADD CONSTRAINT special_advances_status_check
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled', 'reversed')),
  DROP CONSTRAINT special_advances_approved_fields,
  ADD CONSTRAINT special_advances_approved_fields CHECK (
    status NOT IN ('approved', 'disbursed', 'settled', 'reversed') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  DROP CONSTRAINT special_advances_disbursed_fields,
  ADD CONSTRAINT special_advances_disbursed_fields CHECK (
    status NOT IN ('disbursed', 'settled', 'reversed') OR (payout_date IS NOT NULL AND disbursed_by IS NOT NULL AND disbursed_at IS NOT NULL)),
  DROP CONSTRAINT special_advances_payout_record,
  ADD CONSTRAINT special_advances_payout_record CHECK (
    status NOT IN ('disbursed', 'settled', 'reversed')
    OR (payout_method IS NOT NULL AND payout_ledger_group_id IS NOT NULL
        AND (payout_method = 'wallet') = (borrower_kind = 'welile_user')
        AND (payout_method = 'wallet' OR (payout_reference IS NOT NULL AND payout_proof_path IS NOT NULL))
        AND (payout_method <> 'wallet' OR payout_proof_path IS NULL))),
  -- D11c: only an external payout can be reversed
  ADD CONSTRAINT special_advances_reversed_external CHECK (status <> 'reversed' OR borrower_kind = 'external');

ALTER TABLE public.special_advance_events
  DROP CONSTRAINT special_advance_events_event_type_check,
  ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type IN (
    'created', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled', 'reopened', 'reversed',
    'correction_requested', 'correction_approved', 'correction_rejected', 'correction_withdrawn'));

-- ── Corrections ────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE public.special_advance_correction_seq START 1;

CREATE TABLE public.special_advance_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^SAC-[0-9]{6,}$'),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  kind text NOT NULL CHECK (kind IN ('repayment_reversal', 'payout_reversal')),
  repayment_id uuid REFERENCES public.special_advance_repayments(id),
  amount bigint NOT NULL CHECK (amount > 0),
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
  CONSTRAINT special_advance_corrections_target CHECK ((kind = 'repayment_reversal') = (repayment_id IS NOT NULL)),
  CONSTRAINT special_advance_corrections_decided CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT special_advance_corrections_posted CHECK ((status = 'approved') = (ledger_group_id IS NOT NULL)),
  CONSTRAINT special_advance_corrections_rejected_note CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  -- D11b: the approver / rejecter is never the requester; only the requester withdraws
  CONSTRAINT special_advance_corrections_maker_checker CHECK (status NOT IN ('approved', 'rejected') OR decided_by <> requested_by),
  CONSTRAINT special_advance_corrections_withdrawn_self CHECK (status <> 'withdrawn' OR decided_by = requested_by)
);
-- one pending correction per advance at a time; a repayment is reversed at most once
CREATE UNIQUE INDEX special_advance_corrections_one_pending ON public.special_advance_corrections (advance_id) WHERE status = 'pending';
CREATE UNIQUE INDEX special_advance_corrections_one_per_repayment ON public.special_advance_corrections (repayment_id)
  WHERE repayment_id IS NOT NULL AND status IN ('pending', 'approved');
CREATE INDEX special_advance_corrections_status_idx ON public.special_advance_corrections (status, requested_at DESC);

-- A request starts pending; it is decided once (pending -> approved | rejected | withdrawn) and never changes again.
CREATE FUNCTION public._special_advance_guard_correction()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_note IS NOT NULL
       OR NEW.ledger_group_id IS NOT NULL THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_CORRECTION_MUST_START_PENDING' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending'
     OR (NEW.id, NEW.reference, NEW.advance_id, NEW.kind, NEW.repayment_id, NEW.amount, NEW.reason, NEW.proof_path,
         NEW.idempotency_key, NEW.requested_by, NEW.requested_at)
        IS DISTINCT FROM
        (OLD.id, OLD.reference, OLD.advance_id, OLD.kind, OLD.repayment_id, OLD.amount, OLD.reason, OLD.proof_path,
         OLD.idempotency_key, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_CORRECTION_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IN ('approved', 'rejected') AND NOT public._has_enabled_role(NEW.decided_by, ARRAY['cfo']) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_APPROVER_NOT_CFO' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER special_advance_corrections_guard BEFORE INSERT OR UPDATE OR DELETE ON public.special_advance_corrections
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_correction();

REVOKE ALL ON public.special_advance_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.special_advance_corrections TO authenticated;
GRANT ALL ON public.special_advance_corrections TO service_role;
REVOKE ALL ON SEQUENCE public.special_advance_correction_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.special_advance_correction_seq TO service_role;
ALTER TABLE public.special_advance_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY special_advance_corrections_select ON public.special_advance_corrections FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_corrections AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- ── Repayments: the one permitted change is the reversal stamp ─────────────────────────────────────
ALTER TABLE public.special_advance_repayments
  ADD COLUMN reversed_by_correction uuid REFERENCES public.special_advance_corrections(id);

CREATE FUNCTION public._special_advance_guard_repayment_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.reversed_by_correction IS NULL AND NEW.reversed_by_correction IS NOT NULL
     AND (NEW.id, NEW.advance_id, NEW.amount, NEW.received_date, NEW.method, NEW.reference, NEW.proof_path, NEW.note,
          NEW.idempotency_key, NEW.ledger_group_id, NEW.recorded_by, NEW.recorded_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.advance_id, OLD.amount, OLD.received_date, OLD.method, OLD.reference, OLD.proof_path, OLD.note,
          OLD.idempotency_key, OLD.ledger_group_id, OLD.recorded_by, OLD.recorded_at)
     AND EXISTS (SELECT 1 FROM public.special_advance_corrections c
                  WHERE c.id = NEW.reversed_by_correction AND c.kind = 'repayment_reversal'
                    AND c.repayment_id = OLD.id AND c.status = 'approved') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
END $$;
DROP TRIGGER special_advance_repayments_append_only ON public.special_advance_repayments;
CREATE TRIGGER special_advance_repayments_guard BEFORE UPDATE OR DELETE ON public.special_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_repayment_change();

-- A provider reference is recorded once among repayments that stand; a reversed one may be recorded again.
DROP INDEX public.special_advance_repayments_reference_uq;
CREATE UNIQUE INDEX special_advance_repayments_reference_uq ON public.special_advance_repayments (method, upper(btrim(reference)))
  WHERE reversed_by_correction IS NULL;

-- ── Replaced: status edges (settled -> disbursed reopened, disbursed -> reversed) ──────────────────
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
       'settled>disbursed', 'disbursed>reversed') THEN
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

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

-- ── Replaced: audit names the new transitions ──────────────────────────────────────────────────────
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

-- ── Replaced: a reversed repayment's allocations no longer count ───────────────────────────────────
CREATE OR REPLACE FUNCTION public._special_advance_position(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH adv AS (
    SELECT a.total_repayable, a.status IN ('disbursed', 'settled') AS paid_out
      FROM public.special_advances a WHERE a.id = p_id
  ), inst AS (
    SELECT i.number, i.due_date, i.amount, i.access_fee, i.registration_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.g, 0) AS paid_registration, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT x.instalment_number, sum(x.access_fee) a, sum(x.registration_fee) g, sum(x.principal) p
                   FROM public.special_advance_repayment_allocations x
                   JOIN public.special_advance_repayments r ON r.id = x.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE x.advance_id = p_id GROUP BY x.instalment_number) s
        ON s.instalment_number = i.number
     WHERE i.advance_id = p_id
  ), rows AS (
    SELECT *, amount - paid_access - paid_registration - paid_principal AS outstanding FROM inst
  ), g AS (
    SELECT COALESCE((SELECT paid_out FROM adv), false) AS paid_out
  )
  SELECT jsonb_build_object(
    'total_repayable', (SELECT total_repayable FROM adv),
    'paid_out', g.paid_out,
    'scheduled_outstanding', COALESCE((SELECT sum(outstanding) FROM rows), 0),
    'total_paid', COALESCE((SELECT sum(paid_access + paid_registration + paid_principal) FROM rows), 0),
    'outstanding', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows), 0) ELSE 0 END,
    'outstanding_access_fee', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(access_fee - paid_access) FROM rows), 0) ELSE 0 END,
    'outstanding_registration_fee', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(registration_fee - paid_registration) FROM rows), 0) ELSE 0 END,
    'outstanding_principal', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(principal - paid_principal) FROM rows), 0) ELSE 0 END,
    'overdue_amount', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0), 0) ELSE 0 END,
    'overdue_instalments', CASE WHEN g.paid_out THEN (SELECT count(*) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0) ELSE 0 END,
    'instalments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', number, 'due_date', due_date, 'amount', amount,
        'paid', paid_access + paid_registration + paid_principal, 'outstanding', outstanding,
        'status', CASE WHEN outstanding = 0 THEN 'paid'
                       WHEN due_date IS NULL THEN 'not_due'
                       WHEN due_date < public._special_advance_kampala_today() THEN 'overdue'
                       WHEN outstanding < amount THEN 'part_paid' ELSE 'due' END) ORDER BY number) FROM rows), '[]'::jsonb))
  FROM g;
$$;

CREATE OR REPLACE FUNCTION public._special_advance_verify_repayments()
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
  -- only repayments that stand count against the agreed instalments (a reversed one has been taken back)
  IF EXISTS (SELECT 1 FROM public.special_advance_instalments i
               LEFT JOIN (SELECT x.instalment_number, sum(x.access_fee) a, sum(x.registration_fee) g, sum(x.principal) p
                            FROM public.special_advance_repayment_allocations x
                            JOIN public.special_advance_repayments r ON r.id = x.repayment_id AND r.reversed_by_correction IS NULL
                           WHERE x.advance_id = v_adv GROUP BY x.instalment_number) s
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

-- ── Replaced: a proof file is used once across payouts, repayments and corrections ─────────────────
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
     OR EXISTS (SELECT 1 FROM public.special_advance_corrections c WHERE c.proof_path = v_path) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_USED' USING ERRCODE = '23505';
  END IF;
  RETURN v_path;
END $$;

-- ── Replaced: repayment allocation and the reference check ignore reversed repayments ──────────────
CREATE OR REPLACE FUNCTION public.special_advance_record_repayment(p_id uuid, p_repayment jsonb)
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
  v_proof text := NULLIF(btrim(COALESCE(p_repayment ->> 'proof_path', '')), '');
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
       AND e.reference = v_ref AND e.method = v_method AND e.proof_path IS NOT DISTINCT FROM v_proof THEN
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
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments r
              WHERE r.method = v_method AND upper(btrim(r.reference)) = upper(v_ref) AND r.reversed_by_correction IS NULL) THEN
    RAISE EXCEPTION 'REPAYMENT_REFERENCE_ALREADY_RECORDED' USING ERRCODE = '23505';
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D2: the archived receipt / statement of the repayment

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
                                                 ledger_group_id, recorded_by, proof_path)
  VALUES (v_rep, a.id, v_amount::bigint, v_date, v_method, v_ref, v_note, v_key, v_group, v_actor, v_proof);

  v_left := v_amount::bigint;
  FOR i IN
    SELECT x.number,
           x.access_fee - COALESCE(s.a, 0) AS access_fee, x.registration_fee - COALESCE(s.g, 0) AS registration_fee,
           x.principal - COALESCE(s.p, 0) AS principal
      FROM public.special_advance_instalments x
      LEFT JOIN (SELECT al.instalment_number, sum(al.access_fee) a, sum(al.registration_fee) g, sum(al.principal) p
                   FROM public.special_advance_repayment_allocations al
                   JOIN public.special_advance_repayments r ON r.id = al.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE al.advance_id = a.id GROUP BY al.instalment_number) s
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

-- ── Correction read model ──────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public._special_advance_correction_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
    'advance_reference', a.reference,
    'requested_by_name', NULLIF(btrim(rp.full_name), ''),
    'decided_by_name', NULLIF(btrim(dp.full_name), ''),
    'repayment', CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', r.id, 'amount', r.amount, 'received_date', r.received_date, 'method', r.method, 'reference', r.reference) END)
    FROM public.special_advance_corrections c
    JOIN public.special_advances a ON a.id = c.advance_id
    LEFT JOIN public.special_advance_repayments r ON r.id = c.repayment_id
    LEFT JOIN public.profiles rp ON rp.id = c.requested_by
    LEFT JOIN public.profiles dp ON dp.id = c.decided_by
   WHERE c.id = p_id;
$$;

-- ── Replaced: the statement lists corrections and marks reversed repayments ────────────────────────
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
      FROM public.special_advance_corrections c WHERE c.advance_id = p_id), '[]'::jsonb));
END $$;

-- ── Replaced: reconciliation follows corrections; a reversed advance must stand at 0 ───────────────
CREATE OR REPLACE FUNCTION public.special_advance_reconciliation()
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
    FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed');
  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'reference'), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object('reference', a.reference, 'status', a.status,
             'subledger_outstanding', (public._special_advance_position(a.id) ->> 'outstanding')::numeric,
             'ledger_balance', COALESCE((
               SELECT sum(CASE WHEN gl.direction = m.debit_when THEN gl.amount ELSE -gl.amount END)
                 FROM public.general_ledger gl
                 JOIN public.ledger_account_map m ON m.ledger_scope = gl.ledger_scope AND m.category = gl.category AND m.account_code = 'A24'
                WHERE (gl.source_table = 'special_advances' AND gl.source_id = a.id)
                   OR (gl.source_table = 'special_advance_repayments' AND gl.source_id IN (SELECT r.id FROM public.special_advance_repayments r WHERE r.advance_id = a.id))
                   OR (gl.source_table = 'special_advance_corrections' AND gl.source_id IN (SELECT c.id FROM public.special_advance_corrections c WHERE c.advance_id = a.id))), 0)) AS x
      FROM public.special_advances a WHERE a.status IN ('disbursed', 'settled', 'reversed')) t
   WHERE (x ->> 'subledger_outstanding')::numeric <> (x ->> 'ledger_balance')::numeric;
  RETURN jsonb_build_object('a24_ledger_balance', v_ledger, 'subledger_outstanding', v_sub,
                            'difference', v_ledger - v_sub, 'balanced', v_ledger = v_sub AND jsonb_array_length(v_rows) = 0,
                            'mismatched_advances', v_rows);
END $$;

-- ── Request a correction (maker) ───────────────────────────────────────────────────────────────────
-- p_request: {kind: 'repayment_reversal' | 'payout_reversal', repayment_id (repayment reversal), reason, proof_path,
-- idempotency_key}. Records a pending request; nothing is posted. Works whether issuance is on or off (it fixes errors).
CREATE FUNCTION public.special_advance_request_correction(p_id uuid, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_kind text := p_request ->> 'kind';
  v_reason text := NULLIF(btrim(COALESCE(p_request ->> 'reason', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_request ->> 'proof_path', '')), '');
  v_rep_id uuid;
  a public.special_advances%ROWTYPE;
  r public.special_advance_repayments%ROWTYPE;
  e public.special_advance_corrections%ROWTYPE;
  v_amount bigint;
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  BEGIN v_rep_id := NULLIF(p_request ->> 'repayment_id', '')::uuid; EXCEPTION WHEN others THEN v_rep_id := NULL; END;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:correction:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_corrections WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.requested_by = v_actor AND e.kind = v_kind AND e.repayment_id IS NOT DISTINCT FROM v_rep_id
       AND e.proof_path = v_proof AND e.reason = v_reason THEN
      RETURN public._special_advance_correction_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO a FROM public.special_advances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('repayment_reversal', 'payout_reversal') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["kind"]';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 20 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Explain the error in 20 to 1000 characters';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_corrections c WHERE c.advance_id = a.id AND c.status = 'pending') THEN
    RAISE EXCEPTION 'CORRECTION_ALREADY_PENDING' USING ERRCODE = '23505';
  END IF;

  IF v_kind = 'repayment_reversal' THEN
    SELECT * INTO r FROM public.special_advance_repayments WHERE id = v_rep_id AND advance_id = a.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPAYMENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF r.reversed_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'REPAYMENT_ALREADY_REVERSED' USING ERRCODE = '22023';
    END IF;
    IF a.status NOT IN ('disbursed', 'settled') THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    v_amount := r.amount;
  ELSE
    IF a.borrower_kind <> 'external' THEN  -- D11c: a wallet payout is not reversed here
      RAISE EXCEPTION 'PAYOUT_REVERSAL_NOT_SUPPORTED' USING ERRCODE = '22023',
        DETAIL = 'A payout to a Welile wallet cannot be reversed; only an external payout recorded in error';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_repayments x WHERE x.advance_id = a.id AND x.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'REPAYMENTS_MUST_BE_REVERSED_FIRST' USING ERRCODE = '22023';
    END IF;
    v_amount := a.total_repayable;
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D11d

  INSERT INTO public.special_advance_corrections (id, reference, advance_id, kind, repayment_id, amount, reason, proof_path,
                                                  idempotency_key, requested_by)
  VALUES (v_id, 'SAC-' || lpad(nextval('public.special_advance_correction_seq')::text, 6, '0'), a.id, v_kind,
          CASE WHEN v_kind = 'repayment_reversal' THEN r.id END, v_amount, v_reason, v_proof, v_key, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'correction_requested', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('correction_id', v_id, 'kind', v_kind, 'amount', v_amount, 'repayment_id', r.id));
  RETURN public._special_advance_correction_json(v_id) || jsonb_build_object('replayed', false);
END $$;

-- ── Decide a correction (checker) ──────────────────────────────────────────────────────────────────
-- p_decision: 'approve' | 'reject' (a different enabled CFO; rejection needs a note) | 'withdraw' (the requester only).
-- Approval re-checks everything, posts the correcting legs once (fixed key per correction) and updates the records.
CREATE FUNCTION public.special_advance_decide_correction(p_correction_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_note text := public._special_advance_reason(p_note, p_decision = 'reject');
  c public.special_advance_corrections%ROWTYPE;
  a public.special_advances%ROWTYPE;
  r public.special_advance_repayments%ROWTYPE;
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
  SELECT * INTO c FROM public.special_advance_corrections WHERE id = p_correction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CORRECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF c.status <> 'pending' THEN
    IF c.status = v_target AND c.decided_by = v_actor THEN  -- the same decision again: replay
      RETURN public._special_advance_correction_json(c.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'CORRECTION_ALREADY_DECIDED' USING ERRCODE = '22023', DETAIL = c.status;
  END IF;

  IF p_decision = 'withdraw' THEN
    IF c.requested_by <> v_actor THEN
      RAISE EXCEPTION 'ONLY_REQUESTER_MAY_WITHDRAW' USING ERRCODE = '42501';
    END IF;
  ELSIF c.requested_by = v_actor THEN  -- D11b maker-checker
    RAISE EXCEPTION 'SECOND_CFO_REQUIRED' USING ERRCODE = '42501',
      DETAIL = 'A different CFO must approve or reject a correction you requested';
  END IF;

  IF p_decision IN ('reject', 'withdraw') THEN
    UPDATE public.special_advance_corrections
       SET status = v_target, decided_by = v_actor, decided_at = clock_timestamp(), decision_note = v_note
     WHERE id = c.id;
    INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
    SELECT c.advance_id, 'correction_' || v_target, s.status, s.status, v_actor, v_note,
           jsonb_build_object('correction_id', c.id, 'kind', c.kind)
      FROM public.special_advances s WHERE s.id = c.advance_id;
    RETURN public._special_advance_correction_json(c.id) || jsonb_build_object('replayed', false);
  END IF;

  -- approve: re-check against the records as they are now
  SELECT * INTO a FROM public.special_advances WHERE id = c.advance_id FOR UPDATE;
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
  END IF;
  v_desc := format('Special Advance %s correction %s', a.reference, c.reference);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_corrections', 'source_id', c.id,
                              'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  IF c.kind = 'repayment_reversal' THEN
    SELECT * INTO r FROM public.special_advance_repayments WHERE id = c.repayment_id FOR UPDATE;
    IF r.reversed_by_correction IS NOT NULL THEN
      RAISE EXCEPTION 'REPAYMENT_ALREADY_REVERSED' USING ERRCODE = '22023';
    END IF;
    IF a.status NOT IN ('disbursed', 'settled') THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF a.status = 'settled' AND a.borrower_user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.special_advances o WHERE o.borrower_user_id = a.borrower_user_id AND o.id <> a.id
                    AND o.status IN ('pending_approval', 'approved', 'disbursed')) THEN
      RAISE EXCEPTION 'BORROWER_HAS_OPEN_ADVANCE' USING ERRCODE = '22023',
        DETAIL = 'Reopening this advance would give the borrower two open Special Advances';
    END IF;
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_repayment_received',
                                  'description', format('%s: repayment ref %s reversed (company cash)', v_desc, r.reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_repayment',
                                  'description', format('%s: repayment ref %s reversed (receivable restored)', v_desc, r.reference)));
  ELSE
    IF a.borrower_kind <> 'external' OR a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_repayments x WHERE x.advance_id = a.id AND x.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'REPAYMENTS_MUST_BE_REVERSED_FIRST' USING ERRCODE = '22023';
    END IF;
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.principal, 'category', 'special_advance_payout_cash',
                                  'description', format('%s: payout ref %s reversed (company cash)', v_desc, a.payout_reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.principal, 'category', 'special_advance_receivable',
                                  'description', v_desc || ': principal receivable reversed'));
    IF a.access_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.access_fee, 'category', 'special_advance_fee_revenue',
                                        'description', v_desc || ': access fee reversed'))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.access_fee, 'category', 'special_advance_receivable',
                                        'description', v_desc || ': access fee receivable reversed'));
    END IF;
    IF a.registration_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.registration_fee, 'category', 'special_advance_fee_revenue',
                                        'description', v_desc || ': registration fee reversed'))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.registration_fee, 'category', 'special_advance_receivable',
                                        'description', v_desc || ': registration fee receivable reversed'));
    END IF;
  END IF;

  -- one key per correction: it can post only once, whatever happens to the request
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:correction:' || c.id::text, false);

  UPDATE public.special_advance_corrections
     SET status = 'approved', decided_by = v_actor, decided_at = clock_timestamp(), decision_note = v_note, ledger_group_id = v_group
   WHERE id = c.id;
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'correction_approved', a.status, a.status, v_actor, v_note,
          jsonb_build_object('correction_id', c.id, 'kind', c.kind, 'amount', c.amount, 'ledger_group_id', v_group));

  PERFORM set_config('special_advance.correction', c.id::text, true);
  IF c.kind = 'repayment_reversal' THEN
    UPDATE public.special_advance_repayments SET reversed_by_correction = c.id WHERE id = r.id;
    IF a.status = 'settled' THEN
      UPDATE public.special_advances SET status = 'disbursed', settled_at = NULL WHERE id = a.id;
    END IF;
  ELSE
    UPDATE public.special_advances SET status = 'reversed' WHERE id = a.id;
  END IF;
  PERFORM set_config('special_advance.correction', '', true);

  RETURN public._special_advance_correction_json(c.id) || jsonb_build_object('replayed', false);
END $$;

-- The CFO's queue of corrections (pending by default).
CREATE FUNCTION public.special_advance_list_corrections(p_status text DEFAULT 'pending', p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._special_advance_require_cfo();
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["status"]';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(public._special_advance_correction_json(x.id) ORDER BY x.requested_at DESC)
                     FROM (SELECT c.id, c.requested_at FROM public.special_advance_corrections c
                            WHERE p_status IS NULL OR c.status = p_status
                            ORDER BY c.requested_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) x), '[]'::jsonb);
END $$;

-- ── Privileges ─────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._special_advance_guard_correction() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_guard_repayment_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_correction_json(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.special_advance_request_correction(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_decide_correction(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.special_advance_list_corrections(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_request_correction(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_decide_correction(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.special_advance_list_corrections(text, integer) TO authenticated;

-- The replaced functions must keep their privileges (CREATE OR REPLACE keeps them; checked, not assumed).
DO $post$
BEGIN
  IF has_function_privilege('authenticated', 'public._special_advance_position(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._special_advance_check_proof(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._special_advance_audit()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.special_advance_record_repayment(uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.special_advance_record_repayment(uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.special_advance_statement(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.special_advance_reconciliation()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.special_advance_corrections', 'INSERT')
     OR has_table_privilege('anon', 'public.special_advance_corrections', 'SELECT') THEN
    RAISE EXCEPTION 'postcondition failed: a Special Advances privilege changed; nothing was changed';
  END IF;
END
$post$;

RESET lock_timeout;
