-- Rollback of 20261102220000_special_advances_impairment_writeoff. Needs explicit CFO approval.
-- Removes impairment, write-off and recovery: their functions, tables and sequences, the six mapping rows, account A25
-- and the six allowlist categories (the allowlist body is restored to exactly what it was, search_path kept). Restores
-- the six replaced functions VERBATIM (Phase B / Phase 3 definitions) and the Phase B status / event constraints.
-- Refuses (nothing changed) once anything was used: any provision review, write-off or recovery, a written-off advance,
-- an event of a new type, or a ledger leg in a new category. Posted entries are never unwound by a schema rollback.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.special_advance_write_offs') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 20261102220000 is not applied; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_provision_reviews) OR EXISTS (SELECT 1 FROM public.special_advance_write_offs)
     OR EXISTS (SELECT 1 FROM public.special_advance_recoveries) OR EXISTS (SELECT 1 FROM public.special_advances WHERE status = 'written_off')
     OR EXISTS (SELECT 1 FROM public.special_advance_events WHERE event_type IN ('written_off', 'write_off_requested', 'write_off_approved',
                  'write_off_rejected', 'write_off_withdrawn', 'provision_posted', 'recovery_recorded'))
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE category IN ('special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                   'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income')) THEN
    RAISE EXCEPTION 'precondition failed: impairment, write-off or recovery has been used; it is part of the books; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_catalog WHERE code = 'A25' AND label = 'Special Advances — Impairment Allowance')
     OR EXISTS (SELECT 1 FROM public.ledger_account_map WHERE account_code = 'A25' AND category NOT LIKE 'special\_advance\_%') THEN
    RAISE EXCEPTION 'precondition failed: account A25 is not the Special Advances allowance, or other categories map to it; nothing was changed';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public._special_advance_guard_update()', '7c252ea5e107b6b4c6405ad7fbe76f29'),
      ('public._special_advance_audit()', '8153c3967e2c2514bb193fa78bef7a6f'),
      ('public._special_advance_check_proof(uuid,text)', '42fe52ca203a12d8f54919ee282d9320'),
      ('public.special_advance_statement(uuid)', 'dfb4cb837b35e28cd0bfcd7b6dcddceb'),
      ('public.special_advance_reconciliation()', '71689d0f17af58ae872c436f283eab09'),
      ('public._special_advance_eligibility(text,uuid,text,text,text,uuid)', 'b5f250ec93466ca074b74feab1d98432')) v(sig, md5)
  LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'precondition failed: % is not the Phase C definition; nothing was changed', r.sig;
    END IF;
  END LOOP;
END
$pre$;

DROP FUNCTION public.special_advance_list_write_offs(text, integer);
DROP FUNCTION public.special_advance_list_provision_reviews(text, integer);
DROP FUNCTION public.special_advance_record_recovery(uuid, jsonb);
DROP FUNCTION public.special_advance_decide_write_off(uuid, text, text);
DROP FUNCTION public.special_advance_request_write_off(uuid, jsonb);
DROP FUNCTION public.special_advance_decide_provision_review(uuid, text, text);
DROP FUNCTION public.special_advance_request_provision_review(jsonb);
DROP FUNCTION public.special_advance_provision_preview(jsonb);

-- the six functions, exactly as before Phase C
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
  END IF;
  RETURN v;
END $$;

DROP FUNCTION public._special_advance_write_off_json(uuid);
DROP FUNCTION public._special_advance_provision_review_json(uuid);
DROP FUNCTION public._special_advance_provision_proposal(jsonb);
DROP FUNCTION public._special_advance_provision_line(uuid, numeric);
DROP FUNCTION public._special_advance_allowance_held(uuid);
DROP TABLE public.special_advance_recoveries;
DROP TABLE public.special_advance_write_offs;
DROP TABLE public.special_advance_provision_lines;
DROP TABLE public.special_advance_provision_reviews;
DROP FUNCTION public._special_advance_guard_provision_line();
DROP FUNCTION public._special_advance_guard_decided();
DROP FUNCTION public._special_advance_minimum_rate(integer);
DROP SEQUENCE public.special_advance_write_off_seq;
DROP SEQUENCE public.special_advance_provision_seq;

ALTER TABLE public.special_advance_events
  DROP CONSTRAINT special_advance_events_event_type_check,
  ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type IN (
    'created', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled', 'reopened', 'reversed',
    'correction_requested', 'correction_approved', 'correction_rejected', 'correction_withdrawn'));
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
        AND (payout_method <> 'wallet' OR payout_proof_path IS NULL)));

DELETE FROM public.ledger_account_map WHERE category IN ('special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                   'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income');
DELETE FROM public.ledger_account_catalog WHERE code = 'A25' AND label = 'Special Advances — Impairment Allowance';

DO $allow$
DECLARE
  v_before text[] := public.ledger_category_allowlist();
  v_src text;
  v_expr text;
  v_after text[];
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  v_expr := substring(v_src FROM '(?s)^\s*SELECT \((.*)\) \|\| ARRAY\[''special_advance_impairment_charge'', ''special_advance_impairment_allowance'', ''special_advance_write_off'',\s+''special_advance_write_off_loss'', ''special_advance_recovery_received'', ''special_advance_recovery_income''\]::text\[\];\s*$');
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'rollback failed: the allowlist was changed after this migration; restore it by hand';
  END IF;
  -- CREATE OR REPLACE resets SET options: restate the production search_path setting and re-check it afterwards.
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
    RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_temp' AS $body$
  SELECT %s;
$body$$f$, v_expr);
  v_after := public.ledger_category_allowlist();
  IF cardinality(v_after) <> cardinality(v_before) - 6 OR NOT (v_before @> v_after)
     OR v_after && ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',
                   'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income'] THEN
    RAISE EXCEPTION 'rollback check failed: the allowlist was not restored exactly';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=public, extensions, pg_temp'] THEN
    RAISE EXCEPTION 'rollback check failed: the allowlist search_path setting was not preserved';
  END IF;
END
$allow$;

RESET lock_timeout;
