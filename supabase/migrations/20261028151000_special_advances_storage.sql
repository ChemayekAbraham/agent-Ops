-- 2026-10-27: Special Advances, Phase 2: agreement storage. NOT APPLIED. Production apply needs explicit CFO approval.
-- Additive only. Dedicated tables, so the existing agent-advance triggers (enforce_tiered_advance_rate's 33%/28% rewrite,
-- the 33% principal-integrity cap, the agent-only FKs) never touch a Special Advance and existing products are
-- unaffected. Nothing here reads or writes general_ledger, wallets or payments; no money moves.
--
-- Model (CFO decisions 2026-10-27, Phase 1 engine 20261028150000):
--   * borrower: a registered Welile account of any role (borrower_user_id) or an external individual/entity
--     (special_advance_external_borrowers, append-only); exactly one.
--   * agreed terms (principal, rate, basis, term, frequency) and every amount are fixed when the agreement is
--     recorded; a change means cancel and record a new one. A deferred check recomputes the amounts and the whole
--     schedule with _special_advance_schedule at commit and refuses any row that does not match: figures supplied by a
--     browser can never be stored.
--   * schedule rows carry their due offset (days after payout); due dates are set once, from the payout date, when the
--     advance is paid out (the term runs from the payout date, not approval).
--   * status: pending_approval -> approved | rejected | cancelled; approved -> disbursed | cancelled;
--     disbursed -> settled. Each decision column is set once, in its own transition. Approval requires the approver to
--     hold an ENABLED cfo role at that moment (CFO is the sole authority; CEO, Super Admin and admin cannot), enforced
--     here even for direct writes.
--   * special_advance_events is the append-only audit trail; a trigger writes one row per creation and per status
--     change, so no path can skip it.
--   * special_advance_settings.issuance_enabled is the server-side feature flag, OFF by default; only the owner /
--     service role can change it (no browser path).
-- Read access: CFO only (+ staff MFA), pending review. Writes: none for signed-in users; Phase 3 adds CFO-only
-- SECURITY DEFINER functions. No anon access.
-- Open decisions (not encoded): maker-checker (whether the CFO may approve an advance the CFO recorded), external
-- borrower identity requirements (NIN / registration number mandatory?), borrower self-view.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;). The preflight changes nothing when it refuses.
-- Rollback: supabase/rollbacks/20261028151000_special_advances_storage.rollback.sql
-- Tests: src/test/specialAdvanceStorage.test.ts (PGlite).

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regprocedure('public._special_advance_schedule(numeric,numeric,text,numeric,text,date)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: the Special Advances engine (20261028150000) is not applied; nothing was changed';
  END IF;
  IF to_regclass('public.special_advances') IS NOT NULL OR to_regclass('public.special_advance_instalments') IS NOT NULL
     OR to_regclass('public.special_advance_events') IS NOT NULL OR to_regclass('public.special_advance_settings') IS NOT NULL
     OR to_regclass('public.special_advance_external_borrowers') IS NOT NULL OR to_regclass('public.special_advance_ref_seq') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances storage objects already exist; nothing was changed';
  END IF;
  IF to_regclass('auth.users') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._has_enabled_role(uuid,text[])'::regprocedure)
          IS DISTINCT FROM 'd6ffa5096fedec926c3daf15d2af1aec'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.staff_mfa_ok()'::regprocedure)
          IS DISTINCT FROM 'faf13a32385adbb45377f46a4969ad55' THEN
    RAISE EXCEPTION 'precondition failed: auth.users or the role / MFA helpers differ from 2026-10-26; nothing was changed';
  END IF;
END
$pre$;

-- ── Access gate ────────────────────────────────────────────────────────────────────────────────────
-- CFO only. Deliberately not super_admin / ceo / admin (CFO decision 2026-10-27). Used by RLS (so authenticated may
-- execute it; it only returns a boolean) and by the Phase 3 functions.
CREATE FUNCTION public.special_advance_cfo_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND public._has_enabled_role(auth.uid(), ARRAY['cfo']);
$$;

-- ── Feature flag (server side, off by default) ────────────────────────────────────────────────────
CREATE TABLE public.special_advance_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  issuance_enabled boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR length(note) <= 500),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.special_advance_settings (id, issuance_enabled, note)
VALUES (true, false, 'Off by default (2026-10-27). Issuance stays disabled until every phase is approved.');

-- ── External borrowers (append-only: a correction is a new record) ────────────────────────────────
CREATE TABLE public.special_advance_external_borrowers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_type text NOT NULL CHECK (borrower_type IN ('individual', 'entity')),
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 200),
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9]{9,15}$'),
  national_id text CHECK (national_id IS NULL OR national_id ~ '^[A-Z0-9]{8,20}$'),
  registration_number text CHECK (registration_number IS NULL OR length(btrim(registration_number)) BETWEEN 2 AND 60),
  organization text CHECK (organization IS NULL OR length(organization) <= 200),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX special_advance_external_borrowers_phone_idx ON public.special_advance_external_borrowers (phone);

-- ── Agreements ─────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE public.special_advance_ref_seq START 1;

CREATE TABLE public.special_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^SA-[0-9]{6,}$'),
  borrower_kind text NOT NULL CHECK (borrower_kind IN ('welile_user', 'external')),
  borrower_user_id uuid REFERENCES auth.users(id),
  external_borrower_id uuid REFERENCES public.special_advance_external_borrowers(id),
  CONSTRAINT special_advances_one_borrower CHECK (
    (borrower_kind = 'welile_user' AND borrower_user_id IS NOT NULL AND external_borrower_id IS NULL)
    OR (borrower_kind = 'external' AND external_borrower_id IS NOT NULL AND borrower_user_id IS NULL)),

  -- agreed terms (single validity definition: the engine)
  principal bigint NOT NULL,
  rate_percent numeric(5, 2) NOT NULL,
  rate_basis text NOT NULL,
  term_days integer NOT NULL,
  frequency text NOT NULL,
  CONSTRAINT special_advances_terms_valid CHECK (cardinality(public._special_advance_term_errors(
    principal, rate_percent, rate_basis, term_days, frequency, DATE '2000-01-01')) = 0),

  -- server-calculated amounts (verified against the engine at commit)
  access_fee bigint NOT NULL CHECK (access_fee >= 0),
  registration_fee bigint NOT NULL CHECK (registration_fee >= 0),
  total_repayable bigint NOT NULL,
  instalments integer NOT NULL CHECK (instalments >= 1),
  instalment_amount bigint NOT NULL CHECK (instalment_amount > 0),
  calc_version text NOT NULL CHECK (calc_version = 'sa-calc-1'),
  CONSTRAINT special_advances_total CHECK (total_repayable = principal + access_fee + registration_fee),

  purpose text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 15 AND 1000),
  planned_payout_date date,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),

  status text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 5 AND 1000),
  payout_date date,
  disbursed_by uuid,
  disbursed_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT special_advances_approved_fields CHECK (
    status NOT IN ('approved', 'disbursed', 'settled') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT special_advances_rejected_fields CHECK (
    status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND decision_reason IS NOT NULL)),
  CONSTRAINT special_advances_cancelled_fields CHECK (
    status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND decision_reason IS NOT NULL)),
  CONSTRAINT special_advances_disbursed_fields CHECK (
    status NOT IN ('disbursed', 'settled') OR (payout_date IS NOT NULL AND disbursed_by IS NOT NULL AND disbursed_at IS NOT NULL)),
  CONSTRAINT special_advances_settled_fields CHECK (status <> 'settled' OR settled_at IS NOT NULL)
);
CREATE INDEX special_advances_status_idx ON public.special_advances (status, created_at DESC);
CREATE INDEX special_advances_borrower_user_idx ON public.special_advances (borrower_user_id);
CREATE INDEX special_advances_external_borrower_idx ON public.special_advances (external_borrower_id);

CREATE TABLE public.special_advance_instalments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  number integer NOT NULL CHECK (number >= 1),
  due_offset_days integer NOT NULL CHECK (due_offset_days BETWEEN 1 AND 90),
  due_date date,
  amount bigint NOT NULL CHECK (amount > 0),
  access_fee bigint NOT NULL CHECK (access_fee >= 0),
  registration_fee bigint NOT NULL CHECK (registration_fee >= 0),
  principal bigint NOT NULL CHECK (principal >= 0),
  CONSTRAINT special_advance_instalments_split CHECK (access_fee + registration_fee + principal = amount),
  UNIQUE (advance_id, number)
);

CREATE TABLE public.special_advance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  event_type text NOT NULL CHECK (event_type IN ('created', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid NOT NULL,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX special_advance_events_advance_idx ON public.special_advance_events (advance_id, created_at);

-- ── Guards ─────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public._special_advance_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
END $$;

CREATE TRIGGER special_advance_external_borrowers_append_only BEFORE UPDATE OR DELETE ON public.special_advance_external_borrowers
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();
CREATE TRIGGER special_advance_events_append_only BEFORE UPDATE OR DELETE ON public.special_advance_events
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();
CREATE TRIGGER special_advances_no_delete BEFORE DELETE ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();
CREATE TRIGGER special_advance_instalments_no_delete BEFORE DELETE ON public.special_advance_instalments
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();
CREATE TRIGGER special_advance_settings_no_delete BEFORE DELETE ON public.special_advance_settings
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();

-- A new agreement always starts pending, with no decision recorded.
CREATE FUNCTION public._special_advance_guard_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status <> 'pending_approval'
     OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.rejected_by IS NOT NULL OR NEW.rejected_at IS NOT NULL
     OR NEW.cancelled_by IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.decision_reason IS NOT NULL
     OR NEW.payout_date IS NOT NULL OR NEW.disbursed_by IS NOT NULL OR NEW.disbursed_at IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_MUST_START_PENDING' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER special_advances_guard_insert BEFORE INSERT ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_insert();

-- Agreed terms and amounts never change; status moves only along the allowed edges; each decision is set once, in
-- its own transition; approval needs an enabled CFO.
CREATE FUNCTION public._special_advance_guard_update()
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
       'approved>disbursed', 'approved>cancelled', 'disbursed>settled') THEN
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
  IF NEW.settled_at IS DISTINCT FROM OLD.settled_at AND v_edge <> 'disbursed>settled' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'settlement';
  END IF;
  IF NEW.planned_payout_date IS DISTINCT FROM OLD.planned_payout_date AND OLD.status NOT IN ('pending_approval', 'approved') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' USING ERRCODE = '42501', DETAIL = 'planned payout date';
  END IF;

  -- CFO is the sole authority: the approver must hold an enabled cfo role now.
  IF v_edge = 'pending_approval>approved' AND NOT public._has_enabled_role(NEW.approved_by, ARRAY['cfo']) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_APPROVER_NOT_CFO' USING ERRCODE = '42501';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER special_advances_guard_update BEFORE UPDATE ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_update();

-- Audit: one event per creation and per status change, written by the database itself.
CREATE FUNCTION public._special_advance_audit()
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
CREATE TRIGGER special_advances_audit AFTER INSERT OR UPDATE ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_audit();

-- On payout: every instalment gets its due date, payout date + its offset (Kampala calendar day).
CREATE FUNCTION public._special_advance_set_due_dates()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'disbursed' THEN
    UPDATE public.special_advance_instalments
       SET due_date = NEW.payout_date + due_offset_days
     WHERE advance_id = NEW.id AND due_date IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER special_advances_set_due_dates AFTER UPDATE ON public.special_advances
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_set_due_dates();

-- Instalments: the planned split never changes; the due date is set once, only from the payout date.
CREATE FUNCTION public._special_advance_guard_instalment()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  a public.special_advances%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.special_advances WHERE id = NEW.advance_id;
  IF TG_OP = 'INSERT' THEN
    IF a.status <> 'pending_approval' OR NEW.due_date IS NOT NULL THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.advance_id, NEW.number, NEW.due_offset_days, NEW.amount, NEW.access_fee, NEW.registration_fee, NEW.principal)
     IS DISTINCT FROM
     (OLD.id, OLD.advance_id, OLD.number, OLD.due_offset_days, OLD.amount, OLD.access_fee, OLD.registration_fee, OLD.principal) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501';
  END IF;
  IF NEW.due_date IS DISTINCT FROM OLD.due_date
     AND NOT (OLD.due_date IS NULL AND a.status = 'disbursed' AND NEW.due_date = a.payout_date + OLD.due_offset_days) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501', DETAIL = 'due date';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER special_advance_instalments_guard BEFORE INSERT OR UPDATE ON public.special_advance_instalments
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_instalment();

-- At commit: the stored amounts and the stored schedule must be exactly what the engine computes for the agreed
-- terms. Runs for the agreement and for every instalment inserted (so rows cannot be added later either).
CREATE FUNCTION public._special_advance_verify_agreement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  -- via jsonb: PL/pgSQL would resolve NEW.advance_id even on the branch taken for special_advances rows
  v_id uuid := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'special_advances' THEN 'id' ELSE 'advance_id' END)::uuid;
  a public.special_advances%ROWTYPE;
  s jsonb;
  v_rows jsonb;
BEGIN
  SELECT * INTO a FROM public.special_advances WHERE id = v_id;
  s := public._special_advance_schedule(a.principal, a.rate_percent, a.rate_basis, a.term_days, a.frequency, DATE '2000-01-01');
  IF (a.access_fee, a.registration_fee, a.total_repayable, a.instalments, a.instalment_amount, a.calc_version)
     IS DISTINCT FROM
     ((s->>'access_fee')::bigint, (s->>'registration_fee')::bigint, (s->>'total_repayable')::bigint,
      (s->>'instalments')::int, (s->>'instalment_amount')::bigint, s->>'calc_version') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_AMOUNTS_MISMATCH' USING ERRCODE = '23514', DETAIL = a.reference;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_array(i.number, i.due_offset_days, i.amount, i.access_fee, i.registration_fee, i.principal)
                            ORDER BY i.number), '[]'::jsonb)
    INTO v_rows FROM public.special_advance_instalments i WHERE i.advance_id = v_id;
  IF v_rows IS DISTINCT FROM (
       SELECT jsonb_agg(jsonb_build_array((r->>'number')::int, (r->>'due_date')::date - DATE '2000-01-01',
                                          (r->>'amount')::bigint, (r->>'access_fee')::bigint,
                                          (r->>'registration_fee')::bigint, (r->>'principal')::bigint)
                        ORDER BY (r->>'number')::int)
         FROM jsonb_array_elements(s->'schedule') r) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_MISMATCH' USING ERRCODE = '23514', DETAIL = a.reference;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER special_advances_verify AFTER INSERT ON public.special_advances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._special_advance_verify_agreement();
CREATE CONSTRAINT TRIGGER special_advance_instalments_verify AFTER INSERT ON public.special_advance_instalments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._special_advance_verify_agreement();

-- ── Grants and RLS (SELECT for the CFO only; no write path for signed-in users) ───────────────────
REVOKE ALL ON public.special_advances, public.special_advance_instalments, public.special_advance_events,
              public.special_advance_external_borrowers, public.special_advance_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.special_advances, public.special_advance_instalments, public.special_advance_events,
                public.special_advance_external_borrowers, public.special_advance_settings TO authenticated;
GRANT ALL ON public.special_advances, public.special_advance_instalments, public.special_advance_events,
             public.special_advance_external_borrowers, public.special_advance_settings TO service_role;
REVOKE ALL ON SEQUENCE public.special_advance_ref_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.special_advance_ref_seq TO service_role;

ALTER TABLE public.special_advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_instalments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_external_borrowers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_advance_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY special_advances_select ON public.special_advances FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_instalments_select ON public.special_advance_instalments FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_events_select ON public.special_advance_events FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_external_borrowers_select ON public.special_advance_external_borrowers FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));
CREATE POLICY special_advance_settings_select ON public.special_advance_settings FOR SELECT TO authenticated
  USING ((select public.special_advance_cfo_ok()));

CREATE POLICY mfa_required_for_staff ON public.special_advances AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_instalments AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_external_borrowers AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- ── Function privileges ────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.special_advance_cfo_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_cfo_ok() TO authenticated;
REVOKE ALL ON FUNCTION public._special_advance_block_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_guard_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_guard_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_set_due_dates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_guard_instalment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_verify_agreement() FROM PUBLIC, anon, authenticated;

RESET lock_timeout;
