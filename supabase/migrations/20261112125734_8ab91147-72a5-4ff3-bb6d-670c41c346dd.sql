-- Edit issued date and period too (CFO, 12 Nov 2026), on recorded already-issued advances before any repayment/top-up.
DO $do$
DECLARE d text;
BEGIN
  -- advance row: the edit may also change issued date, period and instalment count
  d := pg_get_functiondef('public._special_advance_guard_update()'::regprocedure);
  d := replace(d, '''principal'',''access_fee'',''registration_fee'',''total_repayable'',''instalment_amount'',''updated_at''',
                  '''principal'',''access_fee'',''registration_fee'',''total_repayable'',''instalment_amount'',''instalments'',''term_days'',''payout_date'',''updated_at''');
  IF position('''payout_date'',''updated_at''' in d) = 0 THEN RAISE EXCEPTION 'guard_update changed'; END IF;
  EXECUTE d;

  -- instalments: during the edit, rows may be rebuilt (inserted with due dates, updated, removed)
  d := pg_get_functiondef('public._special_advance_guard_instalment()'::regprocedure);
  d := replace(d, E'  IF TG_OP = ''INSERT'' THEN\n',
    E'  IF NEW.topup_id IS NULL AND COALESCE(current_setting(''special_advance.principal_edit'', true), '''') = NEW.advance_id::text THEN\n    IF NEW.due_date IS DISTINCT FROM a.payout_date + NEW.due_offset_days THEN\n      RAISE EXCEPTION ''SPECIAL_ADVANCE_SCHEDULE_FIXED'' USING ERRCODE = ''42501'';\n    END IF;\n    RETURN NEW;\n  END IF;\n  IF TG_OP = ''INSERT'' THEN\n');
  IF position('a.payout_date + NEW.due_offset_days THEN' in d) = 0 THEN RAISE EXCEPTION 'guard_instalment changed'; END IF;
  EXECUTE d;
END $do$;

CREATE OR REPLACE FUNCTION public._special_advance_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF TG_TABLE_NAME = 'special_advance_instalments' AND TG_OP = 'DELETE' AND OLD.topup_id IS NULL
     AND COALESCE(current_setting('special_advance.principal_edit', true), '') = OLD.advance_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
END $function$;

CREATE OR REPLACE FUNCTION public.special_advance_edit_terms(p_id uuid, p_expected_updated_at timestamptz, p_principal bigint, p_payout_date date, p_term_days int, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_reason text := public._special_advance_reason(p_reason, true);
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
  v_marker text := 'Recorded already-issued outside-Welile advance; no new payment';
  s jsonb; r jsonb; v_err text[]; v_old_fee bigint; v_new_fee bigint;
  v_ref text; v_desc text; v_old jsonb; v_new jsonb; v_legs jsonb; v_g1 uuid; v_g2 uuid; v_cash text;
BEGIN
  IF a.decision_reason IS DISTINCT FROM v_marker THEN RAISE EXCEPTION 'PRINCIPAL_EDIT_ONLY_RECORDED' USING ERRCODE = '22023'; END IF;
  IF a.status <> 'disbursed' THEN RAISE EXCEPTION 'PRINCIPAL_EDIT_NOT_ALLOWED' USING ERRCODE = '22023', DETAIL = a.status; END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments WHERE advance_id = a.id)
     OR EXISTS (SELECT 1 FROM public.special_advance_topups WHERE advance_id = a.id) THEN
    RAISE EXCEPTION 'PRINCIPAL_EDIT_HAS_ACTIVITY' USING ERRCODE = '22023';
  END IF;
  IF p_principal IS NULL OR p_payout_date IS NULL OR p_term_days IS NULL THEN RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023'; END IF;
  IF p_payout_date > public._special_advance_kampala_today() THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = '["original_payout_date"]';
  END IF;
  IF (p_principal, p_payout_date, p_term_days) IS NOT DISTINCT FROM (a.principal, a.payout_date, a.term_days) THEN
    RAISE EXCEPTION 'PRINCIPAL_UNCHANGED' USING ERRCODE = '22023';
  END IF;
  v_err := public._special_advance_term_errors(p_principal::numeric, a.rate_percent, a.rate_basis, p_term_days::numeric, a.frequency, p_payout_date);
  IF cardinality(v_err) > 0 THEN RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = to_jsonb(v_err)::text; END IF;
  s := public._special_advance_schedule(p_principal::numeric, a.rate_percent, a.rate_basis, p_term_days::numeric, a.frequency, p_payout_date);

  v_old_fee := a.access_fee + a.registration_fee;
  v_new_fee := (s->>'access_fee')::bigint + COALESCE((s->>'registration_fee')::bigint, 0);

  PERFORM set_config('special_advance.principal_edit', a.id::text, true);
  UPDATE public.special_advances
     SET principal = p_principal, payout_date = p_payout_date, term_days = p_term_days,
         access_fee = (s->>'access_fee')::bigint, registration_fee = COALESCE((s->>'registration_fee')::bigint, 0),
         total_repayable = (s->>'total_repayable')::bigint, instalments = (s->>'instalments')::int,
         instalment_amount = (s->>'instalment_amount')::bigint, updated_at = clock_timestamp()
   WHERE id = a.id;
  DELETE FROM public.special_advance_instalments WHERE advance_id = a.id AND topup_id IS NULL;
  FOR r IN SELECT x FROM jsonb_array_elements(s->'schedule') x LOOP
    INSERT INTO public.special_advance_instalments (advance_id, number, due_offset_days, due_date, amount, access_fee, registration_fee, principal)
    VALUES (a.id, (r->>'number')::int, (r->>'due_date')::date - p_payout_date, (r->>'due_date')::date,
            (r->>'amount')::bigint, (r->>'access_fee')::bigint, COALESCE((r->>'registration_fee')::bigint, 0), (r->>'principal')::bigint);
  END LOOP;
  PERFORM set_config('special_advance.principal_edit', '', true);

  -- books: reverse the original recording on its old date, re-record the corrected amounts on the corrected date
  v_ref := 'SAE-' || lpad(nextval('public.special_advance_principal_edit_seq')::text, 6, '0');
  v_desc := format('Special Advance %s edit %s', a.reference, v_ref);
  v_cash := format('Original outside-Welile payment by %s, ref %s', a.payout_method, a.payout_reference);
  v_old := jsonb_build_object('ledger_scope','platform','source_table','special_advances','source_id',a.id,'reference_id',v_ref,'currency','UGX',
                              'transaction_date', (a.payout_date::timestamp AT TIME ZONE 'Africa/Kampala'));
  v_new := v_old || jsonb_build_object('transaction_date', (p_payout_date::timestamp AT TIME ZONE 'Africa/Kampala'));
  v_legs := jsonb_build_array(
    v_old || jsonb_build_object('direction','cash_in','amount',a.principal,'category','special_advance_receivable','description',v_desc || ': original principal receivable reversed'),
    v_old || jsonb_build_object('direction','cash_out','amount',a.principal,'category','special_advance_payout_cash','description',v_desc || ': ' || v_cash || ' (reversed)'));
  IF v_old_fee > 0 THEN
    v_legs := v_legs
      || (v_old || jsonb_build_object('direction','cash_in','amount',v_old_fee,'category','special_advance_receivable','description',v_desc || ': original access fee receivable reversed'))
      || (v_old || jsonb_build_object('direction','cash_out','amount',v_old_fee,'category','special_advance_fee_revenue','description',v_desc || ': original access fee reversed'));
  END IF;
  v_g1 := public.create_ledger_transaction(v_legs, 'special_advance:edit:' || v_ref || ':reverse', false);
  v_legs := jsonb_build_array(
    v_new || jsonb_build_object('direction','cash_out','amount',p_principal,'category','special_advance_receivable','description',v_desc || ': principal receivable'),
    v_new || jsonb_build_object('direction','cash_in','amount',p_principal,'category','special_advance_payout_cash','description',v_desc || ': ' || v_cash));
  IF v_new_fee > 0 THEN
    v_legs := v_legs
      || (v_new || jsonb_build_object('direction','cash_out','amount',v_new_fee,'category','special_advance_receivable','description',v_desc || ': access fee receivable'))
      || (v_new || jsonb_build_object('direction','cash_in','amount',v_new_fee,'category','special_advance_fee_revenue','description',v_desc || ': access fee'));
  END IF;
  v_g2 := public.create_ledger_transaction(v_legs, 'special_advance:edit:' || v_ref || ':record', false);

  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'principal_edited', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('reference', v_ref,
            'old', jsonb_build_object('principal', a.principal, 'payout_date', a.payout_date, 'term_days', a.term_days, 'total_repayable', a.total_repayable, 'instalments', a.instalments),
            'new', jsonb_build_object('principal', p_principal, 'payout_date', p_payout_date, 'term_days', p_term_days, 'total_repayable', (s->>'total_repayable')::bigint, 'instalments', (s->>'instalments')::int),
            'ledger_group_ids', jsonb_build_array(v_g1, v_g2)));
  RETURN public.special_advance_statement(a.id);
END $function$;
REVOKE ALL ON FUNCTION public.special_advance_edit_terms(uuid, timestamptz, bigint, date, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_edit_terms(uuid, timestamptz, bigint, date, int, text) TO authenticated, service_role;
-- replaced by special_advance_edit_terms
REVOKE EXECUTE ON FUNCTION public.special_advance_edit_principal(uuid, timestamptz, bigint, text) FROM authenticated;