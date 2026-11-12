-- Special Advances: top-ups (CFO, 12 Nov 2026).
-- The CFO adds a top-up to a paid-out Special Advance from its Actions. In ONE confirmed action the top-up is recorded
-- AND paid out (CFO, 12 Nov 2026: "money should move immediately on adding a top up"):
--   Welile-user borrower -> credited to the borrower's wallet now (same legs as a wallet payout);
--   external borrower    -> paid by mobile money / bank, recorded with its reference and proof (as an external payout).
-- Terms (CFO, 12 Nov 2026): access fee by the engine at the agreement's rate, prorated over the top-up's term, plus the
-- fixed fee; repaid in its own instalments at the agreement's frequency, ending on the ORIGINAL final due date.
-- The original agreement, its instalments and every repayment stay exactly as they are; a top-up adds rows only.
--
-- Ledger (no new category; same legs as a payout, source special_advance_topups):
--   DR A24 principal + access fee | CR L1 (wallet) or CR A1 (external) principal | CR R1 access fee
-- Duplicates: idempotency key (unique), the advance's version (a stale screen is refused), payout reference and proof
-- unique. Audit: special_advance_topups (insert-only, CFO recorder) + event 'topup_posted' + the ledger group.
-- Preflight: refuses unless every replaced function is production's definition of 12 Nov 2026.
-- Rollback: supabase/rollbacks/20261119120000_special_advance_topups.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_position(uuid)'::regprocedure)) <> '30aa90195e213744277d1a502fd471d2'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_json(uuid)'::regprocedure)) <> '2bd7bb27d9e06f6a9fdb250c6a0a774f'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_verify_agreement()'::regprocedure)) <> 'e2fda1064b19bf7df0ef325d9e74f0a2'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_guard_instalment()'::regprocedure)) <> '0096775bcf6313290b97f6198dccdcef'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.special_advance_reconciliation()'::regprocedure)) <> '71689d0f17af58ae872c436f283eab09'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._special_advance_apply_repayment(uuid,uuid,bigint)'::regprocedure)) <> '24d55b23d90905021f150d33042716b8'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.special_advance_record_correction(uuid,jsonb)'::regprocedure)) <> '49f6fe816ec17c6b951c5dbb40d536cc'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.special_advance_my_advances()'::regprocedure)) <> 'c4cc221057d5a024040df15a29181660' THEN
    RAISE EXCEPTION 'precondition failed: a replaced function is no longer production''s definition of 12 Nov 2026; re-derive this migration';
  END IF;
  IF to_regclass('public.special_advance_topups') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: top-ups are already installed';
  END IF;
END $pre$;

-- 1. the top-up record (insert-only; the recorder must be an enabled CFO)
CREATE SEQUENCE public.special_advance_topup_seq;
CREATE TABLE public.special_advance_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^SAT-[0-9]{6}$'),
  advance_id uuid NOT NULL REFERENCES public.special_advances(id),
  topup_date date NOT NULL,
  principal bigint NOT NULL CHECK (principal > 0),
  access_fee bigint NOT NULL CHECK (access_fee >= 0),
  total_repayable bigint NOT NULL,
  term_days integer NOT NULL CHECK (term_days BETWEEN 1 AND 90),
  calc_version text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 15 AND 1000),
  payout_method text NOT NULL CHECK (payout_method IN ('wallet', 'mobile_money', 'bank_transfer')),
  payout_reference text CHECK (payout_reference IS NULL OR length(btrim(payout_reference)) BETWEEN 3 AND 100),
  payout_proof_path text UNIQUE CHECK (payout_proof_path IS NULL OR payout_proof_path ~ '^advances/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$'),
  ledger_group_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT special_advance_topups_total CHECK (total_repayable = principal + access_fee),
  CONSTRAINT special_advance_topups_payout CHECK (
    (payout_method = 'wallet' AND payout_reference IS NULL AND payout_proof_path IS NULL)
    OR (payout_method <> 'wallet' AND payout_reference IS NOT NULL AND payout_proof_path IS NOT NULL))
);
CREATE INDEX special_advance_topups_advance ON public.special_advance_topups (advance_id);
CREATE TRIGGER special_advance_topups_guard BEFORE INSERT OR UPDATE OR DELETE ON public.special_advance_topups
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_guard_posted();
ALTER TABLE public.special_advance_topups ENABLE ROW LEVEL SECURITY;
CREATE POLICY special_advance_topups_select ON public.special_advance_topups FOR SELECT TO authenticated
  USING ((SELECT public.special_advance_cfo_ok()));
CREATE POLICY mfa_required_for_staff ON public.special_advance_topups AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON public.special_advance_topups FROM anon, authenticated;
GRANT SELECT ON public.special_advance_topups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.special_advance_topups TO service_role;
REVOKE ALL ON SEQUENCE public.special_advance_topup_seq FROM anon, authenticated;

-- 2. instalments: a top-up's instalments carry its id; the original agreement's rows keep NULL
ALTER TABLE public.special_advance_instalments ADD COLUMN topup_id uuid REFERENCES public.special_advance_topups(id);
CREATE INDEX special_advance_instalments_topup ON public.special_advance_instalments (topup_id) WHERE topup_id IS NOT NULL;

-- 3. audit event
ALTER TABLE public.special_advance_events DROP CONSTRAINT special_advance_events_event_type_check;
ALTER TABLE public.special_advance_events ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type = ANY (ARRAY[
  'created'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text, 'disbursed'::text, 'settled'::text, 'reopened'::text,
  'reversed'::text, 'correction_posted'::text, 'written_off'::text, 'write_off_posted'::text, 'provision_posted'::text,
  'recovery_recorded'::text, 'topup_posted'::text]));

-- 5. functions that read the schedule or the ledger now include top-ups (production definitions + marked edits)
CREATE OR REPLACE FUNCTION public._special_advance_position(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH adv AS (
    -- the agreement plus every top-up recorded against it
    SELECT a.total_repayable + COALESCE((SELECT sum(t.total_repayable) FROM public.special_advance_topups t WHERE t.advance_id = a.id), 0) AS total_repayable,
           a.status IN ('disbursed', 'settled') AS paid_out
      FROM public.special_advances a WHERE a.id = p_id
  ), inst AS (
    -- one access fee per instalment (a sa-calc-1 instalment stored the fixed part as registration_fee)
    SELECT i.number, i.topup_id, i.due_date, i.amount, i.access_fee + i.registration_fee AS access_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT x.instalment_number, sum(x.access_fee + x.registration_fee) a, sum(x.principal) p
                   FROM public.special_advance_repayment_allocations x
                   JOIN public.special_advance_repayments r ON r.id = x.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE x.advance_id = p_id GROUP BY x.instalment_number) s
        ON s.instalment_number = i.number
     WHERE i.advance_id = p_id
  ), rows AS (
    SELECT *, amount - paid_access - paid_principal AS outstanding FROM inst
  ), g AS (
    SELECT COALESCE((SELECT paid_out FROM adv), false) AS paid_out
  )
  SELECT jsonb_build_object(
    'total_repayable', (SELECT total_repayable FROM adv),
    'paid_out', g.paid_out,
    'scheduled_outstanding', COALESCE((SELECT sum(outstanding) FROM rows), 0),
    'total_paid', COALESCE((SELECT sum(paid_access + paid_principal) FROM rows), 0),
    'outstanding', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows), 0) ELSE 0 END,
    'outstanding_access_fee', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(access_fee - paid_access) FROM rows), 0) ELSE 0 END,
    'outstanding_principal', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(principal - paid_principal) FROM rows), 0) ELSE 0 END,
    'overdue_amount', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0), 0) ELSE 0 END,
    'overdue_instalments', CASE WHEN g.paid_out THEN (SELECT count(*) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0) ELSE 0 END,
    'instalments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', number, 'topup', topup_id IS NOT NULL, 'due_date', due_date, 'amount', amount,
        'paid', paid_access + paid_principal, 'outstanding', outstanding,
        'status', CASE WHEN outstanding = 0 THEN 'paid'
                       WHEN due_date IS NULL THEN 'not_due'
                       WHEN due_date < public._special_advance_kampala_today() THEN 'overdue'
                       WHEN outstanding < amount THEN 'part_paid' ELSE 'due' END) ORDER BY due_date NULLS LAST, number) FROM rows), '[]'::jsonb))
  FROM g;
$function$;

CREATE OR REPLACE FUNCTION public._special_advance_apply_repayment(p_advance_id uuid, p_repayment_id uuid, p_amount bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Allocates one recorded repayment across the instalments and settles the advance when nothing is outstanding.
-- Moved verbatim out of special_advance_record_repayment (production, 12 Nov 2026) so the CFO's Merchant Line
-- recording and the borrower's Pay from Wallet share ONE allocation rule. The caller holds the advance row lock.
DECLARE
  v_left bigint := p_amount;
  i record;
  v_split jsonb;
BEGIN
  FOR i IN
    -- one access fee per instalment (CFO decision 2026-11-03); allocations never record a registration fee
    SELECT x.number,
           x.access_fee + x.registration_fee - COALESCE(s.a, 0) AS access_fee,
           x.principal - COALESCE(s.p, 0) AS principal
      FROM public.special_advance_instalments x
      LEFT JOIN (SELECT al.instalment_number, sum(al.access_fee + al.registration_fee) a, sum(al.principal) p
                   FROM public.special_advance_repayment_allocations al
                   JOIN public.special_advance_repayments r ON r.id = al.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE al.advance_id = p_advance_id GROUP BY al.instalment_number) s
        ON s.instalment_number = x.number
     WHERE x.advance_id = p_advance_id
     ORDER BY x.due_date NULLS LAST, x.number  -- top-up instalments interleave by due date
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN i.access_fee + i.principal = 0;
    v_split := public._special_advance_allocate(jsonb_build_object('late_fee', 0, 'access_fee', i.access_fee,
                 'registration_fee', 0, 'principal', i.principal), v_left);
    INSERT INTO public.special_advance_repayment_allocations (repayment_id, advance_id, instalment_number, access_fee, registration_fee, principal)
    VALUES (p_repayment_id, p_advance_id, i.number, (v_split ->> 'access_fee')::bigint, 0, (v_split ->> 'principal')::bigint);
    v_left := (v_split ->> 'excess')::bigint;
  END LOOP;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF (public._special_advance_position(p_advance_id) ->> 'outstanding')::bigint = 0 THEN
    UPDATE public.special_advances SET status = 'settled', settled_at = clock_timestamp() WHERE id = p_advance_id;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public._special_advance_json(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- CFO decision 2026-11-03: reported as ONE access fee (a sa-calc-1 agreement stored the fixed part separately)
  SELECT (to_jsonb(a) - 'registration_fee') || jsonb_build_object(
    'access_fee', a.access_fee + a.registration_fee,
    'borrower_name', COALESCE(eb.full_name, NULLIF(btrim(pr.full_name), '')),
    'external_borrower', CASE WHEN eb.id IS NULL THEN NULL ELSE to_jsonb(eb) END,
    'schedule', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', i.number, 'due_offset_days', i.due_offset_days, 'due_date', i.due_date, 'amount', i.amount,
        'access_fee', i.access_fee + i.registration_fee, 'principal', i.principal, 'topup_id', i.topup_id) ORDER BY i.due_date NULLS LAST, i.number)
      FROM public.special_advance_instalments i WHERE i.advance_id = a.id), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'event_type', e.event_type, 'from_status', e.from_status, 'to_status', e.to_status, 'actor_id', e.actor_id,
        'actor_name', NULLIF(btrim(ap.full_name), ''), 'reason', e.reason, 'details', e.details, 'created_at', e.created_at)
        ORDER BY e.created_at, e.id)
      FROM public.special_advance_events e LEFT JOIN public.profiles ap ON ap.id = e.actor_id WHERE e.advance_id = a.id), '[]'::jsonb),
    'topups', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.recorded_at) FROM public.special_advance_topups t WHERE t.advance_id = a.id), '[]'::jsonb))
  FROM public.special_advances a
  LEFT JOIN public.special_advance_external_borrowers eb ON eb.id = a.external_borrower_id
  LEFT JOIN public.profiles pr ON pr.id = a.borrower_user_id
  WHERE a.id = p_id;
$function$;

CREATE OR REPLACE FUNCTION public._special_advance_verify_agreement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- via jsonb: PL/pgSQL would resolve NEW.advance_id even on the branch taken for special_advances rows
  v_id uuid := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'special_advances' THEN 'id' ELSE 'advance_id' END)::uuid;
  a public.special_advances%ROWTYPE;
  s jsonb;
  v_rows jsonb;
  t public.special_advance_topups%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.special_advances WHERE id = v_id;
  s := public._special_advance_schedule(a.principal, a.rate_percent, a.rate_basis, a.term_days, a.frequency, DATE '2000-01-01');
  IF (a.access_fee, a.registration_fee, a.total_repayable, a.instalments, a.instalment_amount, a.calc_version)
     IS DISTINCT FROM
     ((s->>'access_fee')::bigint, COALESCE((s->>'registration_fee')::bigint, 0), (s->>'total_repayable')::bigint,
      (s->>'instalments')::int, (s->>'instalment_amount')::bigint, s->>'calc_version') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_AMOUNTS_MISMATCH' USING ERRCODE = '23514', DETAIL = a.reference;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_array(i.number, i.due_offset_days, i.amount, i.access_fee, i.registration_fee, i.principal)
                            ORDER BY i.number), '[]'::jsonb)
    INTO v_rows FROM public.special_advance_instalments i WHERE i.advance_id = v_id AND i.topup_id IS NULL;
  IF v_rows IS DISTINCT FROM (
       SELECT jsonb_agg(jsonb_build_array((r->>'number')::int, (r->>'due_date')::date - DATE '2000-01-01',
                                          (r->>'amount')::bigint, (r->>'access_fee')::bigint,
                                          COALESCE((r->>'registration_fee')::bigint, 0), (r->>'principal')::bigint)
                        ORDER BY (r->>'number')::int)
         FROM jsonb_array_elements(s->'schedule') r) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_MISMATCH' USING ERRCODE = '23514', DETAIL = a.reference;
  END IF;
  -- top-ups (20261119120000): each one's figures and instalments are exactly the engine's, at the agreed rate and
  -- frequency, from the top-up date to the original final due date
  FOR t IN SELECT * FROM public.special_advance_topups x WHERE x.advance_id = v_id LOOP
    s := public._special_advance_schedule(t.principal, a.rate_percent, a.rate_basis, t.term_days, a.frequency, t.topup_date);
    IF (t.access_fee, t.total_repayable, t.calc_version) IS DISTINCT FROM
       ((s->>'access_fee')::bigint, (s->>'total_repayable')::bigint, s->>'calc_version') THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_TOPUP_AMOUNTS_MISMATCH' USING ERRCODE = '23514', DETAIL = t.reference;
    END IF;
    IF (SELECT jsonb_agg(jsonb_build_array(i.due_date, i.amount, i.access_fee + i.registration_fee, i.principal) ORDER BY i.number)
          FROM public.special_advance_instalments i WHERE i.topup_id = t.id)
       IS DISTINCT FROM
       (SELECT jsonb_agg(jsonb_build_array((r->>'due_date')::date, (r->>'amount')::bigint, (r->>'access_fee')::bigint, (r->>'principal')::bigint)
                         ORDER BY (r->>'number')::int)
          FROM jsonb_array_elements(s->'schedule') r) THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_TOPUP_SCHEDULE_MISMATCH' USING ERRCODE = '23514', DETAIL = t.reference;
    END IF;
  END LOOP;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public._special_advance_guard_instalment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  a public.special_advances%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.special_advances WHERE id = NEW.advance_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.topup_id IS NOT NULL THEN
      IF a.status <> 'disbursed' OR COALESCE(current_setting('special_advance.topup', true), '') <> NEW.topup_id::text
         OR NEW.due_date IS DISTINCT FROM a.payout_date + NEW.due_offset_days THEN
        RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF a.status <> 'pending_approval' OR NEW.due_date IS NOT NULL THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.advance_id, NEW.number, NEW.due_offset_days, NEW.amount, NEW.access_fee, NEW.registration_fee, NEW.principal, NEW.topup_id)
     IS DISTINCT FROM
     (OLD.id, OLD.advance_id, OLD.number, OLD.due_offset_days, OLD.amount, OLD.access_fee, OLD.registration_fee, OLD.principal, OLD.topup_id) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501';
  END IF;
  IF NEW.due_date IS DISTINCT FROM OLD.due_date
     AND NOT (OLD.due_date IS NULL AND a.status = 'disbursed' AND NEW.due_date = a.payout_date + OLD.due_offset_days) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_FIXED' USING ERRCODE = '42501', DETAIL = 'due date';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_reconciliation()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                   OR (gl.source_table = 'special_advance_topups' AND gl.source_id IN (SELECT t.id FROM public.special_advance_topups t WHERE t.advance_id = a.id))
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
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_record_correction(p_id uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  BEGIN v_rep_id := NULLIF(p_request ->> 'repayment_id', '')::uuid; EXCEPTION WHEN others THEN v_rep_id := NULL; END;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:correction:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_corrections WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND e.kind = v_kind AND e.repayment_id IS NOT DISTINCT FROM v_rep_id
       AND e.proof_path = v_proof AND e.reason = v_reason THEN
      RETURN public._special_advance_correction_json(e.id) || jsonb_build_object('replayed', true);
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
  IF v_kind IS NULL OR v_kind NOT IN ('repayment_reversal', 'payout_reversal') THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["kind"]';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 20 AND 1000 THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023', DETAIL = 'Explain the error in 20 to 1000 characters';
  END IF;

  IF v_kind = 'repayment_reversal' THEN
    SELECT * INTO r FROM public.special_advance_repayments WHERE id = v_rep_id AND advance_id = a.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPAYMENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
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
    v_amount := r.amount;
  ELSE
    IF a.borrower_kind <> 'external' THEN  -- D11c: a wallet payout is not reversed here
      RAISE EXCEPTION 'PAYOUT_REVERSAL_NOT_SUPPORTED' USING ERRCODE = '22023',
        DETAIL = 'A payout to a Welile wallet cannot be reversed; only an external payout recorded in error';
    END IF;
    IF a.status <> 'disbursed' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_CORRECTABLE' USING ERRCODE = '22023', DETAIL = a.status;
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_topups t WHERE t.advance_id = a.id) THEN
      RAISE EXCEPTION 'PAYOUT_REVERSAL_HAS_TOPUP' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.special_advance_repayments x WHERE x.advance_id = a.id AND x.reversed_by_correction IS NULL) THEN
      RAISE EXCEPTION 'REPAYMENTS_MUST_BE_REVERSED_FIRST' USING ERRCODE = '22023';
    END IF;
    v_amount := a.total_repayable;
  END IF;
  v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D11d

  v_ref := 'SAC-' || lpad(nextval('public.special_advance_correction_seq')::text, 6, '0');
  v_desc := format('Special Advance %s correction %s', a.reference, v_ref);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advance_corrections', 'source_id', v_id,
                              'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  IF v_kind = 'repayment_reversal' AND r.method = 'wallet' THEN
    -- paid from the borrower's wallet: the money goes back to that wallet (CR L1) and the receivable is restored (DR A24)
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'description', format('%s: wallet repayment ref %s reversed (receivable restored)', v_desc, r.reference)),
      v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_wallet_repayment',
                                  'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
                                  'description', format('%s: wallet repayment ref %s returned to the borrower''s wallet', v_desc, r.reference)));
  ELSIF v_kind = 'repayment_reversal' THEN
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', r.amount, 'category', 'special_advance_repayment_received',
                                  'description', format('%s: repayment ref %s reversed (company cash)', v_desc, r.reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', r.amount, 'category', 'special_advance_repayment',
                                  'description', format('%s: repayment ref %s reversed (receivable restored)', v_desc, r.reference)));
  ELSE
    v_legs := jsonb_build_array(
      v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.principal, 'category', 'special_advance_payout_cash',
                                  'description', format('%s: payout ref %s reversed (company cash)', v_desc, a.payout_reference)),
      v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.principal, 'category', 'special_advance_receivable',
                                  'description', v_desc || ': principal receivable reversed'));
    -- one access fee (CFO decision 2026-11-03), as posted at payout
    IF a.access_fee + a.registration_fee > 0 THEN
      v_legs := v_legs
        || (v_src || jsonb_build_object('direction', 'cash_out', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_fee_revenue',
                                        'description', v_desc || ': access fee reversed'))
        || (v_src || jsonb_build_object('direction', 'cash_in', 'amount', a.access_fee + a.registration_fee, 'category', 'special_advance_receivable',
                                        'description', v_desc || ': access fee receivable reversed'));
    END IF;
  END IF;

  -- one key per correction: it can post only once
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:correction:' || v_id::text, false);

  INSERT INTO public.special_advance_corrections (id, reference, advance_id, kind, repayment_id, amount, reason, proof_path,
                                                  idempotency_key, ledger_group_id, recorded_by)
  VALUES (v_id, v_ref, a.id, v_kind, CASE WHEN v_kind = 'repayment_reversal' THEN r.id END, v_amount, v_reason, v_proof,
          v_key, v_group, v_actor);
  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'correction_posted', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('correction_id', v_id, 'kind', v_kind, 'amount', v_amount, 'repayment_id', r.id,
                             'ledger_group_id', v_group));

  PERFORM set_config('special_advance.correction', v_id::text, true);
  IF v_kind = 'repayment_reversal' THEN
    UPDATE public.special_advance_repayments SET reversed_by_correction = v_id WHERE id = r.id;
    IF a.status = 'settled' THEN
      UPDATE public.special_advances SET status = 'disbursed', settled_at = NULL WHERE id = a.id;
    END IF;
  ELSE
    UPDATE public.special_advances SET status = 'reversed' WHERE id = a.id;
  END IF;
  PERFORM set_config('special_advance.correction', '', true);

  RETURN public._special_advance_correction_json(v_id) || jsonb_build_object('replayed', false);
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_my_advances()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- The signed-in borrower's own paid-out Special Advances, with what is owed, the schedule, their repayments and the
-- wallet balance they can pay from. Nothing about anyone else, no proof files, no staff names.
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'wallet_available', public.get_user_available_balance__impl(v_uid),
    'advances', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'reference', a.reference, 'status', a.status, 'principal', a.principal,
        'access_fee', a.access_fee + a.registration_fee, 'total_repayable', (public._special_advance_position(a.id) ->> 'total_repayable')::bigint,
        'topups', COALESCE((SELECT jsonb_agg(jsonb_build_object('reference', t.reference, 'date', t.topup_date, 'principal', t.principal,
            'access_fee', t.access_fee, 'total', t.total_repayable) ORDER BY t.recorded_at)
          FROM public.special_advance_topups t WHERE t.advance_id = a.id), '[]'::jsonb),
        'payout_date', a.payout_date, 'settled_at', a.settled_at,
        'position', public._special_advance_position(a.id),
        'repayments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', r.id, 'amount', r.amount, 'paid_on', r.received_date, 'method', r.method, 'reference', r.reference,
            'reversed', r.reversed_by_correction IS NOT NULL) ORDER BY r.recorded_at DESC)
          FROM public.special_advance_repayments r WHERE r.advance_id = a.id), '[]'::jsonb))
        ORDER BY a.created_at DESC)
      FROM public.special_advances a
      WHERE a.borrower_kind = 'welile_user' AND a.borrower_user_id = v_uid AND a.status IN ('disbursed', 'settled')), '[]'::jsonb));
END $function$;

-- 4. the top-up's terms: the agreement's rate and frequency, from today to the original final due date
CREATE OR REPLACE FUNCTION public._special_advance_topup_schedule(a public.special_advances, p_principal bigint, p_today date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_end date := a.payout_date + a.term_days;
  v_term int := v_end - p_today;
BEGIN
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_TOPUPABLE' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF v_term < 1 THEN
    RAISE EXCEPTION 'TOPUP_AFTER_END' USING ERRCODE = '22023', DETAIL = jsonb_build_object('end_date', v_end)::text;
  END IF;
  IF p_principal IS NULL OR p_principal <= 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["principal"]';
  END IF;
  RETURN jsonb_build_object('term_days', v_term, 'end_date', v_end,
    'schedule', public._special_advance_schedule(p_principal, a.rate_percent, a.rate_basis, v_term, a.frequency, p_today));
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_topup_quote(p_id uuid, p_principal bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- What a top-up of p_principal would cost and how it would be repaid. Read-only; the CFO confirms these figures.
DECLARE
  a public.special_advances%ROWTYPE;
  q jsonb;
  v_out bigint;
BEGIN
  PERFORM public._special_advance_require_cfo();
  SELECT * INTO a FROM public.special_advances WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  q := public._special_advance_topup_schedule(a, p_principal, public._special_advance_kampala_today());
  v_out := (public._special_advance_position(a.id) ->> 'outstanding')::bigint;
  RETURN q || jsonb_build_object('outstanding_now', v_out,
    'outstanding_after', v_out + (q #>> '{schedule,total_repayable}')::bigint,
    'payout_method', CASE WHEN a.borrower_kind = 'welile_user' THEN 'wallet' ELSE NULL END);
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_add_topup(p_id uuid, p_expected_updated_at timestamp with time zone, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- CFO only. Records a top-up against a paid-out Special Advance and pays it out in the same transaction:
-- the ledger group, the top-up record, its instalments, the audit event and the advance's new version, all or nothing.
-- p_request: { idempotency_key, principal, reason, expected_total_repayable, method?, reference?, proof_path? }
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_reason text := NULLIF(btrim(COALESCE(p_request ->> 'reason', '')), '');
  v_method text := p_request ->> 'method';
  v_ref text := NULLIF(btrim(COALESCE(p_request ->> 'reference', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_request ->> 'proof_path', '')), '');
  v_principal bigint;
  a public.special_advances%ROWTYPE;
  e public.special_advance_topups%ROWTYPE;
  eb public.special_advance_external_borrowers%ROWTYPE;
  q jsonb;
  s jsonb;
  r jsonb;
  v_elig text[];
  v_id uuid := gen_random_uuid();
  v_tref text;
  v_desc text;
  v_src jsonb;
  v_legs jsonb;
  v_group uuid;
  v_fee bigint;
  v_n int;
BEGIN
  PERFORM public._special_advance_require_mfa();
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_request ->> 'principal', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["principal"]';
  END IF;
  v_principal := (p_request ->> 'principal')::bigint;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:topup:' || v_key, 0));
  SELECT * INTO e FROM public.special_advance_topups WHERE idempotency_key = v_key;
  IF e.id IS NOT NULL THEN
    IF e.advance_id = p_id AND e.recorded_by = v_actor AND e.principal = v_principal AND e.reason = v_reason
       AND e.payout_method = COALESCE(v_method, e.payout_method) AND e.payout_reference IS NOT DISTINCT FROM v_ref
       AND e.payout_proof_path IS NOT DISTINCT FROM v_proof THEN
      RETURN public.special_advance_statement(p_id) || jsonb_build_object('topup', to_jsonb(e), 'replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  -- the advance as the CFO last saw it: a second click on a stale screen is refused
  a := public._special_advance_lock(p_id, p_expected_updated_at);
  IF a.borrower_user_id = v_actor THEN
    RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501';
  END IF;
  IF NOT public._special_advance_issuance_enabled() THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCES_DISABLED' USING ERRCODE = '55000';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 15 AND 1000 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["reason"]';
  END IF;
  q := public._special_advance_topup_schedule(a, v_principal, v_today);
  s := q -> 'schedule';
  IF COALESCE(p_request ->> 'expected_total_repayable', '') !~ '^[0-9]+$'
     OR (p_request ->> 'expected_total_repayable')::bigint <> (s ->> 'total_repayable')::bigint THEN
    RAISE EXCEPTION 'QUOTE_CHANGED' USING ERRCODE = '22023', DETAIL = jsonb_build_object('total_repayable', (s ->> 'total_repayable')::bigint)::text;
  END IF;

  -- payout, by the same rules as the original payout
  IF a.borrower_kind = 'welile_user' THEN
    v_method := COALESCE(v_method, 'wallet');
    IF v_method <> 'wallet' OR v_ref IS NOT NULL OR v_proof IS NOT NULL THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["method"]';
    END IF;
  ELSE
    IF v_method IS NULL OR v_method NOT IN ('mobile_money', 'bank_transfer') OR v_ref IS NULL OR length(v_ref) NOT BETWEEN 3 AND 100 THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["method","reference"]';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:external-reference:' || lower(v_ref), 0));
    IF EXISTS (SELECT 1 FROM public.special_advances x WHERE lower(btrim(x.payout_reference)) = lower(v_ref))
       OR EXISTS (SELECT 1 FROM public.special_advance_topups x WHERE lower(btrim(x.payout_reference)) = lower(v_ref)) THEN
      RAISE EXCEPTION 'TOPUP_REFERENCE_ALREADY_RECORDED' USING ERRCODE = '23505';
    END IF;
    v_proof := public._special_advance_check_proof(a.id, v_proof);
  END IF;
  -- new money: the borrower must still be eligible (this advance itself excluded)
  SELECT * INTO eb FROM public.special_advance_external_borrowers WHERE id = a.external_borrower_id;
  v_elig := public._special_advance_eligibility(a.borrower_kind, a.borrower_user_id, eb.phone, eb.national_id, eb.registration_number, a.id);
  IF cardinality(v_elig) > 0 THEN
    RAISE EXCEPTION 'BORROWER_NOT_ELIGIBLE' USING ERRCODE = '22023', DETAIL = to_jsonb(v_elig)::text;
  END IF;

  v_tref := 'SAT-' || lpad(nextval('public.special_advance_topup_seq')::text, 6, '0');
  v_fee := (s ->> 'access_fee')::bigint + COALESCE((s ->> 'registration_fee')::bigint, 0);
  v_desc := format('Special Advance %s top-up %s', a.reference, v_tref);
  v_src := jsonb_build_object('source_table', 'special_advance_topups', 'source_id', v_id, 'reference_id', a.reference, 'currency', 'UGX',
                              'transaction_date', (v_today::timestamp AT TIME ZONE 'Africa/Kampala'));
  v_legs := jsonb_build_array(
    v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_principal,
                                'category', 'special_advance_receivable', 'description', v_desc || ': principal receivable'));
  IF a.borrower_kind = 'welile_user' THEN
    v_legs := v_legs || (v_src || jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', v_principal,
                                'category', 'special_advance_credit', 'user_id', a.borrower_user_id, 'wallet_bucket', 'withdrawable',
                                'recipient_type', 'user', 'description', v_desc || ' to the borrower''s wallet'));
  ELSE
    v_legs := v_legs || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_principal,
                                'category', 'special_advance_payout_cash', 'description',
                                format('%s by %s, ref %s', v_desc, replace(v_method, '_', ' '), v_ref)));
  END IF;
  IF v_fee > 0 THEN
    v_legs := v_legs
      || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_fee,
                                      'category', 'special_advance_receivable', 'description', v_desc || ': access fee receivable'))
      || (v_src || jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_fee,
                                      'category', 'special_advance_fee_revenue', 'description', v_desc || ': access fee'));
  END IF;
  -- one key per top-up: it can post only once
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:topup:' || v_id::text, false);

  INSERT INTO public.special_advance_topups (id, reference, advance_id, topup_date, principal, access_fee, total_repayable, term_days,
    calc_version, reason, payout_method, payout_reference, payout_proof_path, ledger_group_id, idempotency_key, recorded_by)
  VALUES (v_id, v_tref, a.id, v_today, v_principal, v_fee, (s ->> 'total_repayable')::bigint, (q ->> 'term_days')::int,
    s ->> 'calc_version', v_reason, v_method, v_ref, v_proof, v_group, v_key, v_actor);

  -- its instalments, numbered after the advance's existing ones and dated from today
  SELECT COALESCE(max(number), 0) INTO v_n FROM public.special_advance_instalments WHERE advance_id = a.id;
  PERFORM set_config('special_advance.topup', v_id::text, true);
  FOR r IN SELECT x FROM jsonb_array_elements(s -> 'schedule') x LOOP
    INSERT INTO public.special_advance_instalments (advance_id, number, due_offset_days, due_date, amount, access_fee, registration_fee, principal, topup_id)
    VALUES (a.id, v_n + (r ->> 'number')::int, (r ->> 'due_date')::date - a.payout_date, (r ->> 'due_date')::date,
            (r ->> 'amount')::bigint, (r ->> 'access_fee')::bigint, 0, (r ->> 'principal')::bigint, v_id);
  END LOOP;
  PERFORM set_config('special_advance.topup', '', true);

  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'topup_posted', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('topup_id', v_id, 'reference', v_tref, 'principal', v_principal, 'access_fee', v_fee,
                             'total_repayable', (s ->> 'total_repayable')::bigint, 'term_days', (q ->> 'term_days')::int,
                             'payout_method', v_method, 'payout_reference', v_ref, 'ledger_group_id', v_group));
  -- a new version of the advance, so a screen opened before this top-up cannot add another by mistake
  UPDATE public.special_advances SET updated_at = clock_timestamp() WHERE id = a.id;

  RETURN public.special_advance_statement(a.id)
         || jsonb_build_object('topup', (SELECT to_jsonb(t) FROM public.special_advance_topups t WHERE t.id = v_id), 'replayed', false);
END $function$;

REVOKE ALL ON FUNCTION public._special_advance_topup_schedule(public.special_advances, bigint, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._special_advance_topup_schedule(public.special_advances, bigint, date) TO service_role;
REVOKE ALL ON FUNCTION public.special_advance_topup_quote(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_topup_quote(uuid, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.special_advance_add_topup(uuid, timestamp with time zone, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_add_topup(uuid, timestamp with time zone, jsonb) TO authenticated, service_role;

-- a top-up is checked against the engine at commit, like the agreement
CREATE CONSTRAINT TRIGGER special_advance_topups_verify AFTER INSERT ON public.special_advance_topups
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public._special_advance_verify_agreement();
