-- ROLLBACK of 20261117140000_special_advance_pay_from_wallet (only on CFO instruction).
-- Restores production's definitions of 12 Nov 2026 verbatim. Refuses while any wallet repayment or wallet ledger row
-- exists: those are real money movements and must first be reversed through a correction (which returns the money).
DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments WHERE method = 'wallet')
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE category = 'special_advance_wallet_repayment') THEN
    RAISE EXCEPTION 'rollback refused: wallet repayments exist; they stay on record';
  END IF;
END $pre$;

DROP FUNCTION public.special_advance_pay_from_wallet(uuid, bigint, bigint, text);
DROP FUNCTION public.special_advance_my_advances();
DROP FUNCTION public._special_advance_wallet_receipt(uuid);

CREATE OR REPLACE FUNCTION public.special_advance_record_repayment(p_id uuid, p_repayment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- one access fee per instalment (CFO decision 2026-11-03); allocations never record a registration fee
    SELECT x.number,
           x.access_fee + x.registration_fee - COALESCE(s.a, 0) AS access_fee,
           x.principal - COALESCE(s.p, 0) AS principal
      FROM public.special_advance_instalments x
      LEFT JOIN (SELECT al.instalment_number, sum(al.access_fee + al.registration_fee) a, sum(al.principal) p
                   FROM public.special_advance_repayment_allocations al
                   JOIN public.special_advance_repayments r ON r.id = al.repayment_id AND r.reversed_by_correction IS NULL
                  WHERE al.advance_id = a.id GROUP BY al.instalment_number) s
        ON s.instalment_number = x.number
     WHERE x.advance_id = a.id
     ORDER BY x.number
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN i.access_fee + i.principal = 0;
    v_split := public._special_advance_allocate(jsonb_build_object('late_fee', 0, 'access_fee', i.access_fee,
                 'registration_fee', 0, 'principal', i.principal), v_left);
    INSERT INTO public.special_advance_repayment_allocations (repayment_id, advance_id, instalment_number, access_fee, registration_fee, principal)
    VALUES (v_rep, a.id, i.number, (v_split ->> 'access_fee')::bigint, 0, (v_split ->> 'principal')::bigint);
    v_left := (v_split ->> 'excess')::bigint;
  END LOOP;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF (public._special_advance_position(a.id) ->> 'outstanding')::bigint = 0 THEN
    UPDATE public.special_advances SET status = 'settled', settled_at = clock_timestamp() WHERE id = a.id;
  END IF;
  RETURN public._special_advance_json(a.id) || jsonb_build_object('position', public._special_advance_position(a.id), 'replayed', false);
END $function$
;

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
END $function$
;

DROP FUNCTION public._special_advance_apply_repayment(uuid, uuid, bigint);

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$

  SELECT (((public.ledger_category_allowlist_base() || ARRAY[

    'staff_loan_charge_collected',

    'agent_advance_receivable_opening',

    'agent_access_fee_receivable_opening',

    'merchandise_recovery_receivable_opening',

    'bike_recovery_receivable_opening',

    'credit_draw_receivable_opening',

    'merchandise_credit_sale_receivable_opening',

    'service_centre_advance_receivable_opening',

    'service_centre_receivable_opening',

    'tenant_service_charge_receivable_opening',

    'business_advance_receivable_opening',

    'rent_plan_receivable_restatement',

    'receivable_restatement_equity',

    'merchandise_recovery_repayment',

    'bike_recovery_repayment',

    'credit_draw_repayment',

    'smartphone_advance_receivable',

    'agent_advance_disbursement',

    'agent_advance_access_fee_charged',

    'agent_advance_registration_fee_charged',

    'agent_advance_fee_revenue',

    'agent_advance_penalty_accrued',

    'agent_advance_penalty_unearned',

    'agent_advance_access_fee_collected',

    'agent_advance_registration_fee_collected',

    'agent_advance_written_off',

    'agent_advance_access_fee_written_off',

    'agent_advance_registration_fee_written_off',

    'agent_advance_reversed',

    'agent_advance_clawback',

    'agent_advance_late_fee_income',

    'agent_advance_access_fee_collected_external',

    'agent_advance_registration_fee_collected_external',

    'agent_advance_penalty_accrued_external',

    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)

    'landlord_pool_reserve_self_support',

    'landlord_pool_reserve_company_managed',

    'landlord_pool_reserve_source',

    'landlord_pool_topup_self_support',

    'landlord_pool_topup_company_managed',

    'landlord_pool_compound_self_support',

    'landlord_pool_compound_company_managed',

    'landlord_pool_deploy_self_support',

    'landlord_pool_deploy_company_managed',

    'landlord_pool_deploy_target',

    'landlord_pool_return_self_support',

    'landlord_pool_return_company_managed',

    'landlord_pool_return_source',

    'landlord_pool_release_self_support',

    'landlord_pool_release_company_managed',

    'landlord_pool_release_target'

  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',

                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',

                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[]

    -- 2026-11-04 (CFO, merchandise phase 3): merchandise sales revenue (R1); offset of the advance shown on an agent's

    -- wallet for a phone bought by the company (L1 memo, not money owed to the agent)

    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']::text[]

    || ARRAY['agent_advance_memo_offset']::text[]

    -- 2026-11-10 (CFO draft): platform-only reversal of a float restatement loss booked in error (X6)

    || ARRAY['float_restatement_correction']::text[]) || ARRAY['welile_cover_fee']::text[]

    -- 2026-11-11 (CFO): salary advances to employees (A27 Loans and Advances to Employees)

    || ARRAY['salary_advance_disbursed', 'salary_advance_cash_paid', 'salary_advance_recovered', 'salary_advance_recovery_expense']::text[]
    -- 2026-11-12 (CFO): Welile Homes landlord float paid to landlords settles the landlord payout obligation (L4)
    || ARRAY['wh_landlord_float_settled']::text[];

$function$
;

DELETE FROM public.ledger_account_map WHERE category = 'special_advance_wallet_repayment';

ALTER TABLE public.special_advance_repayments DROP CONSTRAINT special_advance_repayments_proof_path_check;
ALTER TABLE public.special_advance_repayments ADD CONSTRAINT special_advance_repayments_proof_path_check
  CHECK (proof_path ~ '^advances/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$'::text);
ALTER TABLE public.special_advance_repayments ALTER COLUMN proof_path SET NOT NULL;
ALTER TABLE public.special_advance_repayments DROP CONSTRAINT special_advance_repayments_method_check;
ALTER TABLE public.special_advance_repayments ADD CONSTRAINT special_advance_repayments_method_check
  CHECK (method = ANY (ARRAY['mobile_money'::text, 'bank_transfer'::text]));
