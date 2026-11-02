-- Rollback of 20261102210000_special_advances_corrections. Needs explicit CFO approval.
-- Removes the corrections machinery and restores the eight replaced functions VERBATIM (Phase 4 / Phase A definitions),
-- the original status / event constraints, the repayment append-only trigger and the full reference uniqueness.
-- Refuses (nothing changed) once anything has used it: any correction request, a reversed repayment or advance, or a
-- reopened / correction event. A correction is part of the books; it is never rolled back.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.special_advance_corrections') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances corrections are not applied; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_corrections)
     OR EXISTS (SELECT 1 FROM public.special_advance_repayments WHERE reversed_by_correction IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.special_advances WHERE status = 'reversed')
     OR EXISTS (SELECT 1 FROM public.special_advance_events WHERE event_type NOT IN ('created', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled'))
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE source_table = 'special_advance_corrections') THEN
    RAISE EXCEPTION 'precondition failed: corrections have been used; they are part of the books and are not rolled back; nothing was changed';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public._special_advance_guard_update()', '905973f98fe6440d21fd2edaa4591182'),
      ('public._special_advance_audit()', 'c0cc409f070905a07ff19504b0f196ac'),
      ('public._special_advance_position(uuid)', 'c17b7e48f943731c5c5f8d29f3c2e9dc'),
      ('public._special_advance_verify_repayments()', '50ff7fd66e4ba87d924c7815024fea35'),
      ('public._special_advance_check_proof(uuid,text)', 'd12aa37dc682ebe7f64b376e2255e263'),
      ('public.special_advance_record_repayment(uuid,jsonb)', '6ccc510d8797574fb5e107065bf966e5'),
      ('public.special_advance_statement(uuid)', 'e46ad4cc6e46cf0ea723c705db429947'),
      ('public.special_advance_reconciliation()', '538f7ed60a247b1b7f2eda3d25dd5da7')) v(sig, md5)
  LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'precondition failed: % is not the Phase B definition; nothing was changed', r.sig;
    END IF;
  END LOOP;
END
$pre$;

DROP FUNCTION public.special_advance_request_correction(uuid, jsonb);
DROP FUNCTION public.special_advance_decide_correction(uuid, text, text);
DROP FUNCTION public.special_advance_list_corrections(text, integer);

-- the eight functions, exactly as before Phase B
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

CREATE OR REPLACE FUNCTION public._special_advance_position(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH adv AS (
    SELECT a.total_repayable, a.status IN ('disbursed', 'settled') AS paid_out
      FROM public.special_advances a WHERE a.id = p_id
  ), inst AS (
    SELECT i.number, i.due_date, i.amount, i.access_fee, i.registration_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.g, 0) AS paid_registration, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT instalment_number, sum(access_fee) a, sum(registration_fee) g, sum(principal) p
                   FROM public.special_advance_repayment_allocations WHERE advance_id = p_id GROUP BY instalment_number) s
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
     OR EXISTS (SELECT 1 FROM public.special_advance_repayments r WHERE r.proof_path = v_path) THEN
    RAISE EXCEPTION 'PROOF_ALREADY_USED' USING ERRCODE = '23505';
  END IF;
  RETURN v_path;
END $$;

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
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments r WHERE r.method = v_method AND upper(btrim(r.reference)) = upper(v_ref)) THEN
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
        'proof_path', r.proof_path) ORDER BY r.recorded_at)
      FROM public.special_advance_repayments r WHERE r.advance_id = p_id), '[]'::jsonb));
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

DROP FUNCTION public._special_advance_correction_json(uuid);

DROP TRIGGER special_advance_repayments_guard ON public.special_advance_repayments;
CREATE TRIGGER special_advance_repayments_append_only BEFORE UPDATE OR DELETE ON public.special_advance_repayments
  FOR EACH ROW EXECUTE FUNCTION public._special_advance_block_mutation();
DROP FUNCTION public._special_advance_guard_repayment_change();
DROP INDEX public.special_advance_repayments_reference_uq;
ALTER TABLE public.special_advance_repayments DROP COLUMN reversed_by_correction;
CREATE UNIQUE INDEX special_advance_repayments_reference_uq ON public.special_advance_repayments (method, upper(btrim(reference)));

DROP TABLE public.special_advance_corrections;
DROP FUNCTION public._special_advance_guard_correction();
DROP SEQUENCE public.special_advance_correction_seq;

ALTER TABLE public.special_advance_events
  DROP CONSTRAINT special_advance_events_event_type_check,
  ADD CONSTRAINT special_advance_events_event_type_check
    CHECK (event_type IN ('created', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled'));
ALTER TABLE public.special_advances
  DROP CONSTRAINT special_advances_reversed_external,
  DROP CONSTRAINT special_advances_status_check,
  ADD CONSTRAINT special_advances_status_check
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'cancelled', 'disbursed', 'settled')),
  DROP CONSTRAINT special_advances_approved_fields,
  ADD CONSTRAINT special_advances_approved_fields CHECK (
    status NOT IN ('approved', 'disbursed', 'settled') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  DROP CONSTRAINT special_advances_disbursed_fields,
  ADD CONSTRAINT special_advances_disbursed_fields CHECK (
    status NOT IN ('disbursed', 'settled') OR (payout_date IS NOT NULL AND disbursed_by IS NOT NULL AND disbursed_at IS NOT NULL)),
  DROP CONSTRAINT special_advances_payout_record,
  ADD CONSTRAINT special_advances_payout_record CHECK (
    status NOT IN ('disbursed', 'settled')
    OR (payout_method IS NOT NULL AND payout_ledger_group_id IS NOT NULL
        AND (payout_method = 'wallet') = (borrower_kind = 'welile_user')
        AND (payout_method = 'wallet' OR (payout_reference IS NOT NULL AND payout_proof_path IS NOT NULL))
        AND (payout_method <> 'wallet' OR payout_proof_path IS NULL)));

RESET lock_timeout;
