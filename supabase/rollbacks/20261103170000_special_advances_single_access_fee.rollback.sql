-- Rollback of 20261103170000_special_advances_single_access_fee.sql: restores the ten production definitions of 2026-11-03 verbatim (two fees, sa-calc-1)
-- and drops the two one-access-fee constraints. Advances made under sa-calc-2 keep their stored figures (registration
-- fee 0) and stay valid under the old functions, so the calc_version check keeps accepting 'sa-calc-2' (it is not
-- narrowed back; the old engine only makes sa-calc-1). Refuses (nothing changed) unless the current state is exactly
-- the migration's.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_schedule(numeric, numeric, text, numeric, text, date)'))
       IS DISTINCT FROM '96c3dd958601425c83b348e2d5e4fa42'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_create(jsonb)'))
       IS DISTINCT FROM '33c557fe3f0c106c90d6ec7be5fa2c0d'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_verify_agreement()'))
       IS DISTINCT FROM 'e2fda1064b19bf7df0ef325d9e74f0a2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_json(uuid)'))
       IS DISTINCT FROM '2bd7bb27d9e06f6a9fdb250c6a0a774f'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_position(uuid)'))
       IS DISTINCT FROM '30aa90195e213744277d1a502fd471d2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_verify_repayments()'))
       IS DISTINCT FROM '55dc4aad8afe801df0e514e427af5190'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_record_repayment(uuid, jsonb)'))
       IS DISTINCT FROM '72980eea5163e0b7de8dc4c24a0b91ed'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_disburse(uuid, timestamp with time zone, jsonb)'))
       IS DISTINCT FROM 'c5848007e8960b5b2c1468414f08b7e5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_record_correction(uuid, jsonb)'))
       IS DISTINCT FROM 'adc9fea292474059aa12b112c9fe6def'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_audit()'))
       IS DISTINCT FROM '557a8d46434b4bf3562a2ccc0fc9a101' THEN
    RAISE EXCEPTION 'precondition failed: the Special Advances functions are not the current state of 20261103170000; nothing was changed';
  END IF;
END
$pre$;

ALTER TABLE public.special_advances DROP CONSTRAINT special_advances_one_access_fee;
ALTER TABLE public.special_advance_repayment_allocations DROP CONSTRAINT special_advance_allocations_one_access_fee;

CREATE OR REPLACE FUNCTION public._special_advance_schedule(
  p_principal numeric, p_rate_percent numeric, p_rate_basis text, p_term_days numeric, p_frequency text, p_start_date date)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_errors text[] := public._special_advance_term_errors(p_principal, p_rate_percent, p_rate_basis, p_term_days, p_frequency, p_start_date);
  v_p bigint;
  v_bp bigint;          -- rate in hundredths of a percent (28% = 2800, 0.5% = 50)
  v_term int;
  v_step int;
  v_n int;
  v_fee bigint;
  v_reg bigint;
  v_total bigint;
  v_inst bigint;
  v_access_left bigint;
  v_reg_left bigint;
  v_prin_left bigint;
  v_remaining bigint;
  v_amt bigint;
  v_left bigint;
  v_a bigint;
  v_r bigint;
  v_pr bigint;
  v_due date;
  v_rows jsonb := '[]'::jsonb;
  k int;
BEGIN
  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_TERMS' USING ERRCODE = '22023', DETAIL = to_jsonb(v_errors)::text;
  END IF;

  v_p := p_principal::bigint;
  v_bp := (p_rate_percent * 100)::bigint;
  v_term := p_term_days::int;
  -- exact numeric arithmetic; round() on a positive numeric is half up
  v_fee := CASE WHEN p_rate_basis = 'daily'
                THEN round((v_p::numeric * v_bp * v_term) / 10000)
                ELSE round((v_p::numeric * v_bp * v_term) / 300000) END;
  v_reg := CASE WHEN v_p <= 200000 THEN 10000 ELSE 20000 END;
  v_total := v_p + v_fee + v_reg;
  v_step := CASE p_frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 ELSE 30 END;
  v_n := ceil(v_term::numeric / v_step)::int;
  v_inst := ceil(v_total::numeric / v_n)::bigint;

  v_access_left := v_fee;
  v_reg_left := v_reg;
  v_prin_left := v_p;
  v_remaining := v_total;
  FOR k IN 1 .. v_n LOOP
    v_amt := CASE WHEN k = v_n THEN v_remaining ELSE least(v_inst, v_remaining) END;
    IF v_amt <= 0 THEN
      -- cannot happen within the limits (n(n-1) < total); refuse rather than store a zero instalment
      RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_INVARIANT' USING ERRCODE = 'P0001';
    END IF;
    v_left := v_amt;
    v_a := least(v_left, v_access_left);  v_left := v_left - v_a;  v_access_left := v_access_left - v_a;
    v_r := least(v_left, v_reg_left);     v_left := v_left - v_r;  v_reg_left := v_reg_left - v_r;
    v_pr := least(v_left, v_prin_left);   v_left := v_left - v_pr; v_prin_left := v_prin_left - v_pr;
    v_remaining := v_remaining - v_amt;
    v_due := p_start_date + least(k * v_step, v_term);
    v_rows := v_rows || jsonb_build_object(
      'number', k, 'due_date', to_char(v_due, 'YYYY-MM-DD'), 'amount', v_amt,
      'access_fee', v_a, 'registration_fee', v_r, 'principal', v_pr, 'balance_after', v_remaining);
  END LOOP;
  IF v_remaining <> 0 OR v_access_left <> 0 OR v_reg_left <> 0 OR v_prin_left <> 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_INVARIANT' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'calc_version', 'sa-calc-1',
    'principal', v_p, 'rate_percent', p_rate_percent, 'rate_basis', p_rate_basis, 'term_days', v_term,
    'frequency', p_frequency, 'start_date', to_char(p_start_date, 'YYYY-MM-DD'),
    'access_fee', v_fee, 'registration_fee', v_reg, 'total_repayable', v_total,
    'instalments', v_n, 'instalment_amount', v_inst,
    'final_instalment_amount', (v_rows -> (v_n - 1) ->> 'amount')::bigint,
    'first_due_date', v_rows -> 0 ->> 'due_date',
    'final_due_date', v_rows -> (v_n - 1) ->> 'due_date',
    'schedule', v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.special_advance_create(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_key text := btrim(COALESCE(p_request ->> 'idempotency_key', ''));
  v_planned date;
  v_purpose text := NULLIF(btrim(COALESCE(p_request ->> 'purpose', '')), '');
  b jsonb;
  t jsonb;
  s jsonb;
  v_errs text[] := '{}';
  v_elig text[];
  v_ext uuid;
  v_id uuid := gen_random_uuid();
  v_seq bigint;
  e public.special_advances%ROWTYPE;
  r jsonb;
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- Same key, concurrently or later: serialise, then return the advance already recorded for it.
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:key:' || v_key, 0));
  SELECT * INTO e FROM public.special_advances WHERE idempotency_key = v_key;

  BEGIN
    v_planned := NULLIF(p_request ->> 'planned_payout_date', '')::date;
  EXCEPTION WHEN others THEN
    v_errs := v_errs || 'planned_payout_date'::text;
  END;
  IF v_planned IS NOT NULL AND v_planned < v_today THEN v_errs := v_errs || 'planned_payout_date'::text; END IF;
  IF v_purpose IS NULL OR length(v_purpose) NOT BETWEEN 15 AND 1000 THEN v_errs := v_errs || 'purpose'::text; END IF;
  b := public._special_advance_parse_borrower(p_request);
  t := public._special_advance_parse_terms(p_request, COALESCE(v_planned, v_today));
  v_errs := v_errs || ARRAY(SELECT jsonb_array_elements_text(b -> 'errors')) || ARRAY(SELECT jsonb_array_elements_text(t -> 'errors'));
  IF cardinality(v_errs) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = to_jsonb(v_errs)::text;
  END IF;
  s := t -> 'schedule';

  IF e.id IS NOT NULL THEN
    -- Replay: identical request -> the same advance; anything different -> refused.
    IF e.created_by = v_actor AND e.borrower_kind = b ->> 'kind'
       AND e.borrower_user_id IS NOT DISTINCT FROM (b ->> 'user_id')::uuid
       AND (e.principal, e.rate_percent, e.rate_basis, e.term_days, e.frequency)
           = ((s ->> 'principal')::bigint, (s ->> 'rate_percent')::numeric, s ->> 'rate_basis', (s ->> 'term_days')::int, s ->> 'frequency')
       AND e.purpose = v_purpose AND e.planned_payout_date IS NOT DISTINCT FROM v_planned
       AND (e.borrower_kind = 'welile_user' OR EXISTS (
             SELECT 1 FROM public.special_advance_external_borrowers x
              WHERE x.id = e.external_borrower_id AND x.borrower_type = b ->> 'borrower_type' AND x.full_name = b ->> 'full_name'
                AND x.phone = b ->> 'phone' AND x.national_id IS NOT DISTINCT FROM b ->> 'national_id'
                AND x.registration_number IS NOT DISTINCT FROM b ->> 'registration_number')) THEN
      RETURN public._special_advance_json(e.id) || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505',
      DETAIL = 'This idempotency key was already used for a different request';
  END IF;

  IF NOT public._special_advance_issuance_enabled() THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCES_DISABLED' USING ERRCODE = '55000',
      DETAIL = 'Special Advance issuance is switched off (special_advance_settings.issuance_enabled)';
  END IF;
  -- CFO confirmation: the total the CFO saw must be the total the server computes.
  IF NULLIF(p_request ->> 'expected_total_repayable', '') IS NULL
     OR (p_request ->> 'expected_total_repayable') !~ '^[0-9]+$'
     OR (p_request ->> 'expected_total_repayable')::bigint <> (s ->> 'total_repayable')::bigint THEN
    RAISE EXCEPTION 'QUOTE_CHANGED' USING ERRCODE = '22023',
      DETAIL = jsonb_build_object('total_repayable', (s ->> 'total_repayable')::bigint)::text;
  END IF;

  -- One open advance per borrower: serialise on every identity the borrower has.
  IF b ->> 'kind' = 'welile_user' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:user:' || (b ->> 'user_id'), 0));
    IF (b ->> 'user_id')::uuid = v_actor THEN
      RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE = '42501', DETAIL = 'A CFO cannot record a Special Advance to themselves';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:phone:' || public._special_advance_norm_phone(b ->> 'phone'), 0));
    IF b ->> 'national_id' IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:nin:' || (b ->> 'national_id'), 0));
    END IF;
    IF b ->> 'registration_number' IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:reg:' || upper(b ->> 'registration_number'), 0));
    END IF;
  END IF;
  v_elig := public._special_advance_eligibility(b ->> 'kind', (b ->> 'user_id')::uuid, b ->> 'phone',
                                                 b ->> 'national_id', b ->> 'registration_number', NULL);
  IF cardinality(v_elig) > 0 THEN
    RAISE EXCEPTION 'BORROWER_NOT_ELIGIBLE' USING ERRCODE = '22023', DETAIL = to_jsonb(v_elig)::text;
  END IF;

  IF b ->> 'kind' = 'external' THEN
    INSERT INTO public.special_advance_external_borrowers (borrower_type, full_name, phone, national_id, registration_number,
                                                            organization, notes, created_by)
    VALUES (b ->> 'borrower_type', b ->> 'full_name', b ->> 'phone', b ->> 'national_id', b ->> 'registration_number',
            b ->> 'organization', b ->> 'notes', v_actor)
    RETURNING id INTO v_ext;
  END IF;

  v_seq := nextval('public.special_advance_ref_seq');
  INSERT INTO public.special_advances (
    id, reference, borrower_kind, borrower_user_id, external_borrower_id,
    principal, rate_percent, rate_basis, term_days, frequency,
    access_fee, registration_fee, total_repayable, instalments, instalment_amount, calc_version,
    purpose, planned_payout_date, idempotency_key, created_by)
  VALUES (
    v_id, 'SA-' || CASE WHEN length(v_seq::text) < 6 THEN lpad(v_seq::text, 6, '0') ELSE v_seq::text END,
    b ->> 'kind', (b ->> 'user_id')::uuid, v_ext,
    (s ->> 'principal')::bigint, (s ->> 'rate_percent')::numeric, s ->> 'rate_basis', (s ->> 'term_days')::int, s ->> 'frequency',
    (s ->> 'access_fee')::bigint, (s ->> 'registration_fee')::bigint, (s ->> 'total_repayable')::bigint,
    (s ->> 'instalments')::int, (s ->> 'instalment_amount')::bigint, s ->> 'calc_version',
    v_purpose, v_planned, v_key, v_actor);

  FOR r IN SELECT x FROM jsonb_array_elements(s -> 'schedule') x LOOP
    INSERT INTO public.special_advance_instalments (advance_id, number, due_offset_days, amount, access_fee, registration_fee, principal)
    VALUES (v_id, (r ->> 'number')::int, (r ->> 'due_date')::date - COALESCE(v_planned, v_today),
            (r ->> 'amount')::bigint, (r ->> 'access_fee')::bigint, (r ->> 'registration_fee')::bigint, (r ->> 'principal')::bigint);
  END LOOP;

  RETURN public._special_advance_json(v_id) || jsonb_build_object('replayed', false);
END $$;

CREATE OR REPLACE FUNCTION public._special_advance_verify_agreement()
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

CREATE OR REPLACE FUNCTION public._special_advance_json(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(a) || jsonb_build_object(
    'borrower_name', COALESCE(eb.full_name, NULLIF(btrim(pr.full_name), '')),
    'external_borrower', CASE WHEN eb.id IS NULL THEN NULL ELSE to_jsonb(eb) END,
    'schedule', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', i.number, 'due_offset_days', i.due_offset_days, 'due_date', i.due_date, 'amount', i.amount,
        'access_fee', i.access_fee, 'registration_fee', i.registration_fee, 'principal', i.principal) ORDER BY i.number)
      FROM public.special_advance_instalments i WHERE i.advance_id = a.id), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'event_type', e.event_type, 'from_status', e.from_status, 'to_status', e.to_status, 'actor_id', e.actor_id,
        'actor_name', NULLIF(btrim(ap.full_name), ''), 'reason', e.reason, 'details', e.details, 'created_at', e.created_at)
        ORDER BY e.created_at, e.id)
      FROM public.special_advance_events e LEFT JOIN public.profiles ap ON ap.id = e.actor_id WHERE e.advance_id = a.id), '[]'::jsonb))
  FROM public.special_advances a
  LEFT JOIN public.special_advance_external_borrowers eb ON eb.id = a.external_borrower_id
  LEFT JOIN public.profiles pr ON pr.id = a.borrower_user_id
  WHERE a.id = p_id;
$$;

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

CREATE OR REPLACE FUNCTION public.special_advance_disburse(p_id uuid, p_expected_updated_at timestamptz, p_payout jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
  eb public.special_advance_external_borrowers%ROWTYPE;
  v_date date;
  v_method text := p_payout ->> 'method';
  v_ref text := NULLIF(btrim(COALESCE(p_payout ->> 'reference', '')), '');
  v_proof text := NULLIF(btrim(COALESCE(p_payout ->> 'proof_path', '')), '');
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
    IF v_proof IS NOT NULL THEN  -- a wallet payout is internal: no external proof belongs to it
      RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["proof_path"]';
    END IF;
  ELSE
    IF v_method IS NULL OR v_method NOT IN ('mobile_money', 'bank_transfer') OR v_ref IS NULL OR length(v_ref) NOT BETWEEN 3 AND 100 THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["method","reference"]';
    END IF;
    v_proof := public._special_advance_check_proof(a.id, v_proof);  -- D1: the archived receipt of the off-platform payment
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
         payout_method = v_method, payout_reference = v_ref, payout_ledger_group_id = v_group, payout_proof_path = v_proof
   WHERE id = a.id;
  RETURN public._special_advance_json(a.id) || jsonb_build_object('position', public._special_advance_position(a.id));
END $$;

CREATE OR REPLACE FUNCTION public.special_advance_record_correction(p_id uuid, p_request jsonb)
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
  IF v_kind = 'repayment_reversal' THEN
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

DO $post$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_schedule(numeric, numeric, text, numeric, text, date)'))
       IS DISTINCT FROM '72d88fa24d0125c66ef7ad63579d8264'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_create(jsonb)'))
       IS DISTINCT FROM '325f9aab5c6c69b120feda88634e40c5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_verify_agreement()'))
       IS DISTINCT FROM '114b0cd006b5618976b1f06694a3fca2'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_json(uuid)'))
       IS DISTINCT FROM '340f44043709ad13682469d2b867d001'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_position(uuid)'))
       IS DISTINCT FROM 'c17b7e48f943731c5c5f8d29f3c2e9dc'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_verify_repayments()'))
       IS DISTINCT FROM '50ff7fd66e4ba87d924c7815024fea35'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_record_repayment(uuid, jsonb)'))
       IS DISTINCT FROM '6ccc510d8797574fb5e107065bf966e5'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_disburse(uuid, timestamp with time zone, jsonb)'))
       IS DISTINCT FROM '44065a5c57df6f4f8bf785c80b2b3d15'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.special_advance_record_correction(uuid, jsonb)'))
       IS DISTINCT FROM 'bef74b0e245a0c754f00705ddddc768c'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public._special_advance_audit()'))
       IS DISTINCT FROM 'c8033574751a7ee91b9318a0a00909da' THEN
    RAISE EXCEPTION 'postcondition failed: the rollback did not restore the production definitions; nothing was changed';
  END IF;
END
$post$;

RESET lock_timeout;
