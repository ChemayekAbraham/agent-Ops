-- Edit the principal of an already-issued advance that was recorded (CFO, 12 Nov 2026).
-- Only while nothing has been repaid or topped up; fee and instalments are recalculated at the agreed terms,
-- and the books get one adjustment for the difference. Original rows stay; the change is in History.

ALTER TABLE public.special_advance_events DROP CONSTRAINT special_advance_events_event_type_check;
ALTER TABLE public.special_advance_events ADD CONSTRAINT special_advance_events_event_type_check CHECK (event_type = ANY (ARRAY['created','approved','rejected','cancelled','disbursed','settled','reopened','reversed','correction_posted','written_off','write_off_posted','provision_posted','recovery_recorded','topup_posted','note_added','principal_edited']::text[]));

CREATE SEQUENCE IF NOT EXISTS public.special_advance_principal_edit_seq;

DO $do$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public._special_advance_guard_update()'::regprocedure);
  d := regexp_replace(d, E'BEGIN\n', E'BEGIN\n  IF COALESCE(current_setting(''special_advance.principal_edit'', true), '''') = OLD.id::text THEN\n    IF (to_jsonb(NEW) - ARRAY[''principal'',''access_fee'',''registration_fee'',''total_repayable'',''instalment_amount'',''updated_at''])\n       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[''principal'',''access_fee'',''registration_fee'',''total_repayable'',''instalment_amount'',''updated_at'']) THEN\n      RAISE EXCEPTION ''SPECIAL_ADVANCE_TERMS_IMMUTABLE'' USING ERRCODE = ''42501'';\n    END IF;\n    RETURN NEW;\n  END IF;\n');
  EXECUTE d;

  d := pg_get_functiondef('public._special_advance_guard_instalment()'::regprocedure);
  d := replace(d, E'  IF (NEW.id, NEW.advance_id, NEW.number, NEW.due_offset_days, NEW.amount,',
    E'  IF NEW.topup_id IS NULL AND COALESCE(current_setting(''special_advance.principal_edit'', true), '''') = NEW.advance_id::text THEN\n    IF (NEW.id, NEW.advance_id, NEW.number, NEW.due_offset_days, NEW.due_date, NEW.topup_id)\n       IS DISTINCT FROM (OLD.id, OLD.advance_id, OLD.number, OLD.due_offset_days, OLD.due_date, OLD.topup_id) THEN\n      RAISE EXCEPTION ''SPECIAL_ADVANCE_SCHEDULE_FIXED'' USING ERRCODE = ''42501'';\n    END IF;\n    RETURN NEW;\n  END IF;\n  IF (NEW.id, NEW.advance_id, NEW.number, NEW.due_offset_days, NEW.amount,');
  IF position('principal_edit' in d) = 0 THEN RAISE EXCEPTION 'instalment guard changed'; END IF;
  EXECUTE d;
END $do$;

CREATE OR REPLACE FUNCTION public.special_advance_edit_principal(p_id uuid, p_expected_updated_at timestamptz, p_principal bigint, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_actor uuid := public._special_advance_require_cfo();
  v_reason text := public._special_advance_reason(p_reason, true);
  a public.special_advances%ROWTYPE := public._special_advance_lock(p_id, p_expected_updated_at);
  v_marker text := 'Recorded already-issued outside-Welile advance; no new payment';
  s jsonb; r jsonb; v_err text[];
  v_old_fee bigint; v_new_fee bigint; v_dp bigint; v_df bigint;
  v_ref text; v_desc text; v_src jsonb; v_legs jsonb := '[]'::jsonb; v_group uuid;
BEGIN
  IF a.decision_reason IS DISTINCT FROM v_marker THEN
    RAISE EXCEPTION 'PRINCIPAL_EDIT_ONLY_RECORDED' USING ERRCODE = '22023', DETAIL = 'Only already-issued advances that were recorded can be edited';
  END IF;
  IF a.status <> 'disbursed' THEN
    RAISE EXCEPTION 'PRINCIPAL_EDIT_NOT_ALLOWED' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advance_repayments WHERE advance_id = a.id)
     OR EXISTS (SELECT 1 FROM public.special_advance_topups WHERE advance_id = a.id) THEN
    RAISE EXCEPTION 'PRINCIPAL_EDIT_HAS_ACTIVITY' USING ERRCODE = '22023', DETAIL = 'A repayment or top-up has been recorded';
  END IF;
  IF p_principal IS NULL OR p_principal = a.principal THEN
    RAISE EXCEPTION 'PRINCIPAL_UNCHANGED' USING ERRCODE = '22023';
  END IF;
  v_err := public._special_advance_term_errors(p_principal::numeric, a.rate_percent, a.rate_basis, a.term_days::numeric, a.frequency, a.payout_date);
  IF cardinality(v_err) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_REQUEST' USING ERRCODE = '22023', DETAIL = to_jsonb(v_err)::text;
  END IF;
  s := public._special_advance_schedule(p_principal::numeric, a.rate_percent, a.rate_basis, a.term_days::numeric, a.frequency, a.payout_date);
  IF (s->>'instalments')::int <> a.instalments OR s->>'calc_version' IS DISTINCT FROM a.calc_version THEN
    RAISE EXCEPTION 'PRINCIPAL_EDIT_SCHEDULE_CHANGED' USING ERRCODE = '22023';
  END IF;

  v_old_fee := a.access_fee + a.registration_fee;
  v_new_fee := (s->>'access_fee')::bigint + COALESCE((s->>'registration_fee')::bigint, 0);
  v_dp := p_principal - a.principal;
  v_df := v_new_fee - v_old_fee;

  PERFORM set_config('special_advance.principal_edit', a.id::text, true);
  UPDATE public.special_advances
     SET principal = p_principal, access_fee = (s->>'access_fee')::bigint, registration_fee = COALESCE((s->>'registration_fee')::bigint, 0),
         total_repayable = (s->>'total_repayable')::bigint, instalment_amount = (s->>'instalment_amount')::bigint,
         updated_at = clock_timestamp()
   WHERE id = a.id;
  FOR r IN SELECT x FROM jsonb_array_elements(s->'schedule') x LOOP
    UPDATE public.special_advance_instalments
       SET amount = (r->>'amount')::bigint, access_fee = (r->>'access_fee')::bigint,
           registration_fee = COALESCE((r->>'registration_fee')::bigint, 0), principal = (r->>'principal')::bigint
     WHERE advance_id = a.id AND topup_id IS NULL AND number = (r->>'number')::int;
    IF NOT FOUND THEN RAISE EXCEPTION 'PRINCIPAL_EDIT_SCHEDULE_CHANGED' USING ERRCODE = '22023'; END IF;
  END LOOP;
  PERFORM set_config('special_advance.principal_edit', '', true);

  -- books: one adjustment for the difference (same accounts as the original recording)
  v_ref := 'SAE-' || lpad(nextval('public.special_advance_principal_edit_seq')::text, 6, '0');
  v_desc := format('Special Advance %s principal edit %s (UGX %s to %s)', a.reference, v_ref, a.principal, p_principal);
  v_src := jsonb_build_object('ledger_scope', 'platform', 'source_table', 'special_advances', 'source_id', a.id,
                              'reference_id', v_ref, 'currency', 'UGX',
                              'transaction_date', (public._special_advance_kampala_today()::timestamp AT TIME ZONE 'Africa/Kampala'));
  IF v_dp <> 0 THEN
    v_legs := v_legs
      || (v_src || jsonb_build_object('direction', CASE WHEN v_dp > 0 THEN 'cash_out' ELSE 'cash_in' END, 'amount', abs(v_dp),
                                      'category', 'special_advance_receivable', 'description', v_desc || ': principal receivable'))
      || (v_src || jsonb_build_object('direction', CASE WHEN v_dp > 0 THEN 'cash_in' ELSE 'cash_out' END, 'amount', abs(v_dp),
                                      'category', 'special_advance_payout_cash', 'description', v_desc || ': original outside-Welile payment'));
  END IF;
  IF v_df <> 0 THEN
    v_legs := v_legs
      || (v_src || jsonb_build_object('direction', CASE WHEN v_df > 0 THEN 'cash_out' ELSE 'cash_in' END, 'amount', abs(v_df),
                                      'category', 'special_advance_receivable', 'description', v_desc || ': access fee receivable'))
      || (v_src || jsonb_build_object('direction', CASE WHEN v_df > 0 THEN 'cash_in' ELSE 'cash_out' END, 'amount', abs(v_df),
                                      'category', 'special_advance_fee_revenue', 'description', v_desc || ': access fee'));
  END IF;
  v_group := public.create_ledger_transaction(v_legs, 'special_advance:principal_edit:' || v_ref, false);

  INSERT INTO public.special_advance_events (advance_id, event_type, from_status, to_status, actor_id, reason, details)
  VALUES (a.id, 'principal_edited', a.status, a.status, v_actor, v_reason,
          jsonb_build_object('reference', v_ref, 'old_principal', a.principal, 'new_principal', p_principal,
                             'old_total_repayable', a.total_repayable, 'new_total_repayable', (s->>'total_repayable')::bigint,
                             'old_access_fee', v_old_fee, 'new_access_fee', v_new_fee, 'ledger_group_id', v_group));
  RETURN public.special_advance_statement(a.id);
END $function$;
REVOKE ALL ON FUNCTION public.special_advance_edit_principal(uuid, timestamptz, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.special_advance_edit_principal(uuid, timestamptz, bigint, text) TO authenticated, service_role;

-- Edit is principal only now; the note action is withdrawn (no notes were saved).
REVOKE EXECUTE ON FUNCTION public.special_advance_add_note(uuid, text) FROM authenticated;