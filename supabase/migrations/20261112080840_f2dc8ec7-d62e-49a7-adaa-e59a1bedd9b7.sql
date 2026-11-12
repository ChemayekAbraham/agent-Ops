CREATE FUNCTION public.special_advance_record_historical(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_today date := public._special_advance_kampala_today();
  v_id uuid; v_date date; v_method text; v_ref text; v_proof text;
  v_key text := btrim(COALESCE(p_request->>'idempotency_key',''));
  v_purpose text := NULLIF(btrim(COALESCE(p_request->>'purpose','')), '');
  v_marker text := 'Recorded already-issued outside-Welile advance; no new payment';
  b jsonb; t jsonb; s jsonb; r jsonb; v_elig text[]; v_ext uuid; v_seq bigint;
  a public.special_advances%ROWTYPE; v_src jsonb; v_legs jsonb; v_group uuid;
BEGIN
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'REQUEST_INVALID' USING ERRCODE='22023';
  END IF;
  IF (p_request->>'confirm_not_recorded') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'HISTORICAL_CONFIRMATION_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF length(v_key) NOT BETWEEN 16 AND 100 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_id := (p_request->>'advance_id')::uuid;
    v_date := (p_request->>'original_payout_date')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE='22023', DETAIL='["original_payout_date","advance_id"]';
  END;
  IF v_id IS NULL OR v_date IS NULL OR v_date > v_today THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE='22023', DETAIL='["original_payout_date","advance_id"]';
  END IF;
  v_method := p_request->>'method';
  v_ref := NULLIF(btrim(COALESCE(p_request->>'reference','')), '');
  v_proof := NULLIF(btrim(COALESCE(p_request->>'proof_path','')), '');
  IF v_method IS NULL OR v_method NOT IN ('mobile_money','bank_transfer','cash') OR v_ref IS NULL OR length(v_ref) NOT BETWEEN 3 AND 100 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE='22023', DETAIL='["method","reference"]';
  END IF;
  IF v_purpose IS NULL OR length(v_purpose) NOT BETWEEN 15 AND 1000 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE='22023', DETAIL='["purpose"]';
  END IF;
  b := public._special_advance_parse_borrower(p_request);
  t := public._special_advance_parse_terms(p_request, v_date);
  IF jsonb_array_length(b->'errors') > 0 OR jsonb_array_length(t->'errors') > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE='22023', DETAIL=((b->'errors') || (t->'errors'))::text;
  END IF;
  s := t->'schedule';
  IF NULLIF(p_request->>'expected_total_repayable','') IS NULL OR (p_request->>'expected_total_repayable') !~ '^[0-9]+$'
     OR (p_request->>'expected_total_repayable')::bigint <> (s->>'total_repayable')::bigint THEN
    RAISE EXCEPTION 'QUOTE_CHANGED' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:key:' || v_key,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:historical-id:' || v_id::text,0));
  SELECT * INTO a FROM public.special_advances WHERE idempotency_key=v_key OR id=v_id LIMIT 1;
  IF FOUND THEN
    IF a.id=v_id AND a.idempotency_key=v_key AND a.created_by=v_actor AND a.decision_reason=v_marker
       AND a.borrower_kind=b->>'kind' AND a.borrower_user_id IS NOT DISTINCT FROM (b->>'user_id')::uuid
       AND (a.principal,a.rate_percent,a.rate_basis,a.term_days,a.frequency,a.purpose,a.payout_date,a.payout_method,a.payout_reference,a.payout_proof_path)
       IS NOT DISTINCT FROM ((s->>'principal')::bigint,(s->>'rate_percent')::numeric,s->>'rate_basis',(s->>'term_days')::int,s->>'frequency',v_purpose,v_date,v_method,v_ref,v_proof)
       AND (a.borrower_kind='welile_user' OR EXISTS (SELECT 1 FROM public.special_advance_external_borrowers x WHERE x.id=a.external_borrower_id
           AND (x.borrower_type,x.full_name,x.phone,x.national_id,x.registration_number,x.organization)
           IS NOT DISTINCT FROM (b->>'borrower_type',b->>'full_name',b->>'phone',b->>'national_id',b->>'registration_number',b->>'organization'))) THEN
      RETURN public.special_advance_statement(a.id) || jsonb_build_object('replayed',true,'historical',true,'payment_sent',false);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:external-reference:' || lower(v_ref),0));
  IF EXISTS (SELECT 1 FROM public.special_advances WHERE lower(btrim(payout_reference))=lower(v_ref)) THEN
    RAISE EXCEPTION 'HISTORICAL_REFERENCE_ALREADY_RECORDED' USING ERRCODE='23505';
  END IF;
  IF b->>'kind'='welile_user' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:user:' || (b->>'user_id'),0));
    IF (b->>'user_id')::uuid=v_actor THEN RAISE EXCEPTION 'SELF_ADVANCE' USING ERRCODE='42501'; END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:phone:' || COALESCE(b->>'phone',''),0));
    IF NULLIF(b->>'national_id','') IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:nin:' || (b->>'national_id'),0)); END IF;
    IF NULLIF(b->>'registration_number','') IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('special_advance:reg:' || (b->>'registration_number'),0)); END IF;
  END IF;
  v_elig := public._special_advance_eligibility(b->>'kind',(b->>'user_id')::uuid,b->>'phone',b->>'national_id',b->>'registration_number',NULL);
  IF cardinality(v_elig)>0 THEN RAISE EXCEPTION 'BORROWER_NOT_ELIGIBLE' USING ERRCODE='22023', DETAIL=to_jsonb(v_elig)::text; END IF;
  v_proof := public._special_advance_check_proof(v_id,v_proof);
  IF NOT public._special_advance_issuance_enabled() THEN RAISE EXCEPTION 'SPECIAL_ADVANCES_DISABLED' USING ERRCODE='55000'; END IF;
  IF b->>'kind'='external' THEN
    INSERT INTO public.special_advance_external_borrowers(borrower_type,full_name,phone,national_id,registration_number,organization,notes,created_by)
    VALUES(b->>'borrower_type',b->>'full_name',b->>'phone',b->>'national_id',b->>'registration_number',b->>'organization',b->>'notes',v_actor) RETURNING id INTO v_ext;
  END IF;
  v_seq := nextval('public.special_advance_ref_seq');
  INSERT INTO public.special_advances(id,reference,borrower_kind,borrower_user_id,external_borrower_id,principal,rate_percent,rate_basis,term_days,frequency,
    access_fee,registration_fee,total_repayable,instalments,instalment_amount,calc_version,purpose,idempotency_key,created_by)
  VALUES(v_id,'SA-' || CASE WHEN length(v_seq::text)<6 THEN lpad(v_seq::text,6,'0') ELSE v_seq::text END,b->>'kind',(b->>'user_id')::uuid,v_ext,
    (s->>'principal')::bigint,(s->>'rate_percent')::numeric,s->>'rate_basis',(s->>'term_days')::int,s->>'frequency',
    (s->>'access_fee')::bigint,COALESCE((s->>'registration_fee')::bigint,0),(s->>'total_repayable')::bigint,(s->>'instalments')::int,(s->>'instalment_amount')::bigint,s->>'calc_version',v_purpose,v_key,v_actor);
  FOR r IN SELECT x FROM jsonb_array_elements(s->'schedule') x LOOP
    INSERT INTO public.special_advance_instalments(advance_id,number,due_offset_days,amount,access_fee,registration_fee,principal)
    VALUES(v_id,(r->>'number')::int,(r->>'due_date')::date-v_date,(r->>'amount')::bigint,(r->>'access_fee')::bigint,COALESCE((r->>'registration_fee')::bigint,0),(r->>'principal')::bigint);
  END LOOP;
  UPDATE public.special_advances SET status='approved',approved_by=v_actor,approved_at=clock_timestamp(),decision_reason=v_marker WHERE id=v_id;
  v_src := jsonb_build_object('source_table','special_advances','source_id',v_id,'reference_id','SA-' || CASE WHEN length(v_seq::text)<6 THEN lpad(v_seq::text,6,'0') ELSE v_seq::text END,'currency','UGX','transaction_date',v_date::timestamp AT TIME ZONE 'Africa/Kampala');
  v_legs := jsonb_build_array(
    v_src || jsonb_build_object('ledger_scope','platform','direction','cash_out','amount',(s->>'principal')::bigint,'category','special_advance_receivable','description',v_marker || ': principal receivable'),
    v_src || jsonb_build_object('ledger_scope','platform','direction','cash_in','amount',(s->>'principal')::bigint,'category','special_advance_payout_cash','description',format('Original outside-Welile payment by %s, ref %s',v_method,v_ref)));
  IF (s->>'access_fee')::bigint+COALESCE((s->>'registration_fee')::bigint,0)>0 THEN
    v_legs := v_legs || jsonb_build_array(
      v_src || jsonb_build_object('ledger_scope','platform','direction','cash_out','amount',(s->>'access_fee')::bigint+COALESCE((s->>'registration_fee')::bigint,0),'category','special_advance_receivable','description',v_marker || ': access fee receivable'),
      v_src || jsonb_build_object('ledger_scope','platform','direction','cash_in','amount',(s->>'access_fee')::bigint+COALESCE((s->>'registration_fee')::bigint,0),'category','special_advance_fee_revenue','description',v_marker || ': access fee'));
  END IF;
  v_group := public.create_ledger_transaction(v_legs,'special_advance:' || v_id::text || ':payout',false);
  UPDATE public.special_advances SET status='disbursed',payout_date=v_date,disbursed_by=v_actor,disbursed_at=clock_timestamp(),
    payout_method=v_method,payout_reference=v_ref,payout_proof_path=v_proof,payout_ledger_group_id=v_group WHERE id=v_id;
  RETURN public.special_advance_statement(v_id) || jsonb_build_object('replayed',false,'historical',true,'payment_sent',false);
END $function$;
REVOKE ALL ON FUNCTION public.special_advance_record_historical(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_record_historical(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.special_advance_record_historical(jsonb) IS 'CFO-only atomic recording of already-issued, previously unrecorded outside-Welile advances. Platform accounting only; never sends a payment or credits a wallet.';