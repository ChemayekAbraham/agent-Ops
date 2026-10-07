-- Merchandise / smartphone / bike-lease recovery eligibility gate (approved 2026-10-07).
-- No ledger, wallet or order data is modified. Built-in checks abort the whole migration on any failure.

CREATE OR REPLACE FUNCTION public.merchandise_sale_recognition_eligible(p_sale_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_sale_id IS NULL THEN true ELSE COALESCE((
    SELECT s.order_status IN ('approved','processing','issued','completed')
       AND CASE s.fulfilment_type
             WHEN 'company_issued' THEN s.handed_over_at IS NOT NULL
             WHEN 'outsourced'     THEN s.cfo_disbursed_at IS NOT NULL
             ELSE true END
    FROM public.merchandise_sales s WHERE s.id = p_sale_id), false) END
$$;

CREATE OR REPLACE FUNCTION public.merchandise_plan_ineligible_reason(p_plan_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p.id IS NULL THEN 'plan_not_found'
    WHEN p.status <> 'active' THEN 'plan_not_active'
    WHEN COALESCE(p.outstanding_balance,0) <= 0 THEN 'nothing_outstanding'
    WHEN p.sale_id IS NULL THEN NULL
    WHEN s.id IS NULL THEN 'order_missing'
    WHEN s.order_status NOT IN ('approved','processing','issued','completed') THEN 'order_' || COALESCE(s.order_status,'unknown')
    WHEN s.fulfilment_type = 'company_issued' AND s.handed_over_at IS NULL THEN 'awaiting_handover'
    WHEN s.fulfilment_type = 'outsourced' AND s.cfo_disbursed_at IS NULL THEN 'awaiting_cfo_disbursement'
    ELSE NULL END
  FROM (SELECT p_plan_id AS id) x
  LEFT JOIN public.merchandise_recovery_plans p ON p.id = x.id
  LEFT JOIN public.merchandise_sales s ON s.id = p.sale_id
$$;

CREATE OR REPLACE FUNCTION public.merchandise_plan_recovery_eligible(p_plan_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans WHERE id = p_plan_id)
     AND public.merchandise_plan_ineligible_reason(p_plan_id) IS NULL
$$;

REVOKE ALL ON FUNCTION public.merchandise_sale_recognition_eligible(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.merchandise_plan_ineligible_reason(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.merchandise_plan_recovery_eligible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merchandise_sale_recognition_eligible(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merchandise_plan_ineligible_reason(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merchandise_plan_recovery_eligible(uuid) TO authenticated, service_role;

DO $p$
DECLARE d text; o text; n text;
BEGIN
  d := pg_get_functiondef('public.recover_merchandise_from_wallets(uuid,date)'::regprocedure);
  o := '    IF v_plan.starts_on IS NOT NULL AND v_plan.starts_on > v_today THEN CONTINUE; END IF;';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'patch1 anchor mismatch'; END IF;
  n := '    IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = ''skipped_ineligible_order'' WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object(''plan_id'', v_plan.id, ''item'', v_plan.item_name, ''day'', v_today,
        ''taken'', 0, ''outcome'', ''skipped_ineligible_order'', ''reason'', public.merchandise_plan_ineligible_reason(v_plan.id));
      CONTINUE;
    END IF;
' || o;
  EXECUTE replace(d, o, n);

  d := pg_get_functiondef('public.recover_smartphone_from_wallets()'::regprocedure);
  o := '    v_daily := COALESCE(NULLIF(v_plan.daily_deduction_amount, 0), 0);';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'patch2 anchor mismatch'; END IF;
  n := '    IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
      UPDATE public.merchandise_recovery_plans SET last_attempt_result = ''skipped_ineligible_order'' WHERE id = v_plan.id;
      v_results := v_results || jsonb_build_object(''plan_id'', v_plan.id, ''outcome'', ''skipped_ineligible_order'',
        ''reason'', public.merchandise_plan_ineligible_reason(v_plan.id));
      CONTINUE;
    END IF;
' || o;
  EXECUTE replace(d, o, n);

  d := pg_get_functiondef('public.agent_pay_merchandise_plan(uuid,numeric)'::regprocedure);
  o := '    RETURN jsonb_build_object(''success'', false, ''error'', ''plan_not_active'');
  END IF;';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'patch3 anchor mismatch'; END IF;
  n := o || '
  IF NOT public.merchandise_plan_recovery_eligible(v_plan.id) THEN
    RETURN jsonb_build_object(''success'', false, ''error'', ''order_not_eligible'',
      ''reason'', public.merchandise_plan_ineligible_reason(v_plan.id));
  END IF;';
  EXECUTE replace(d, o, n);

  o := '    RAISE EXCEPTION ''Quantity must be greater than zero'';
  END IF;';
  n := o || '
  IF p_quantity > 20 THEN
    RAISE EXCEPTION ''Maximum 20 units per order. Contact operations for bulk orders.'';
  END IF;';
  d := pg_get_functiondef('public.agent_purchase_merchandise(uuid,integer,text,text)'::regprocedure);
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'patch4 anchor mismatch'; END IF;
  EXECUTE replace(d, o, n);
  d := pg_get_functiondef('public.agent_purchase_merchandise_plan(uuid,integer,text,integer)'::regprocedure);
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'patch5 anchor mismatch'; END IF;
  EXECUTE replace(d, o, n);

  d := pg_get_viewdef('public.v_receivables_lines'::regclass);
  o := 'WHERE ((r.status = ''active''::text) AND (COALESCE(r.outstanding_balance, (0)::numeric) > (0)::numeric) AND ';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 2 THEN RAISE EXCEPTION 'patch6a anchor mismatch'; END IF;
  d := replace(d, o, o || 'public.merchandise_plan_recovery_eligible(r.id) AND ');
  o := 'WHERE ((COALESCE(s.amount_outstanding, (0)::numeric) > (0)::numeric) AND ';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN RAISE EXCEPTION 'patch6b anchor mismatch'; END IF;
  d := replace(d, o, o || 'public.merchandise_sale_recognition_eligible(s.id) AND ');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_receivables_lines AS ' || rtrim(rtrim(d), ';');
END $p$;

DO $t$
DECLARE v_total numeric; v_n int; v_ok boolean; v_gl_before bigint; v_gl_after bigint;
  v_annet_sale text; v_annet_plan text; v_r jsonb; v_cat uuid; v_q int; v_uid uuid;
BEGIN
  SELECT md5(row(s.*)::text) INTO v_annet_sale FROM merchandise_sales s WHERE id='9bc4e223-3f86-4b61-bc46-11904d443c58';
  SELECT md5(row(p.*)::text) INTO v_annet_plan FROM merchandise_recovery_plans p WHERE id='eab6500c-cec5-401b-afc1-d20eac6ec378';
  SELECT count(*) INTO v_gl_before FROM general_ledger;

  IF merchandise_plan_recovery_eligible('eab6500c-cec5-401b-afc1-d20eac6ec378') THEN RAISE EXCEPTION 'T1 Annet plan eligible'; END IF;
  IF EXISTS (SELECT 1 FROM v_receivables_lines WHERE item_id IN ('eab6500c-cec5-401b-afc1-d20eac6ec378','9bc4e223-3f86-4b61-bc46-11904d443c58')) THEN RAISE EXCEPTION 'T1 Annet in receivables'; END IF;

  IF merchandise_plan_recovery_eligible('3c285b40-c3b8-4219-92be-6eabed01bfd5') THEN RAISE EXCEPTION 'T2 pending eligible'; END IF;
  BEGIN
    UPDATE merchandise_sales SET order_status='approved' WHERE id='c3b415c8-8a57-4140-ab5f-332749c91c57';
    IF NOT merchandise_plan_recovery_eligible('3c285b40-c3b8-4219-92be-6eabed01bfd5') THEN RAISE EXCEPTION 'T2 approved not eligible'; END IF;
    UPDATE merchandise_sales SET order_status='rejected' WHERE id='c3b415c8-8a57-4140-ab5f-332749c91c57';
    IF merchandise_plan_recovery_eligible('3c285b40-c3b8-4219-92be-6eabed01bfd5') THEN RAISE EXCEPTION 'T2 rejected eligible'; END IF;
    RAISE EXCEPTION 'undo_ok';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'undo_ok' THEN RAISE; END IF; END;

  IF EXISTS (SELECT 1 FROM merchandise_sales WHERE fulfilment_type='company_issued' AND handed_over_at IS NULL AND merchandise_sale_recognition_eligible(id)) THEN RAISE EXCEPTION 'T3 unhanded company item eligible'; END IF;
  IF EXISTS (SELECT 1 FROM merchandise_sales WHERE fulfilment_type='outsourced' AND cfo_disbursed_at IS NULL AND merchandise_sale_recognition_eligible(id)) THEN RAISE EXCEPTION 'T3 unpaid outsourced eligible'; END IF;

  SELECT count(*) INTO v_n FROM merchandise_recovery_plans rp JOIN merchandise_sales s ON s.id=rp.sale_id
   WHERE rp.is_bike_lease AND s.order_status='rejected' AND rp.status='active' AND merchandise_plan_recovery_eligible(rp.id);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 rejected bikes still eligible: %', v_n; END IF;
  SELECT count(*) INTO v_n FROM merchandise_recovery_plans rp JOIN merchandise_sales s ON s.id=rp.sale_id
   WHERE rp.is_bike_lease AND s.order_status='approved' AND rp.status='active' AND rp.outstanding_balance>0 AND merchandise_plan_recovery_eligible(rp.id);
  IF v_n <> 3 THEN RAISE EXCEPTION 'T5 legitimate bike leases: %', v_n; END IF;

  SELECT count(*) INTO v_n FROM v_receivables_lines WHERE source_table='merchandise_recovery_plans';
  IF v_n <> 55 THEN RAISE EXCEPTION 'T6 legitimate plans in receivables: % (expected 55)', v_n; END IF;

  SELECT customer_id INTO v_uid FROM merchandise_recovery_plans WHERE id='eab6500c-cec5-401b-afc1-d20eac6ec378';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role','authenticated')::text, true);
  SELECT id INTO v_cat FROM merchandise_catalog WHERE is_active AND COALESCE(array_length(sizes,1),0)=0 LIMIT 1;
  FOREACH v_q IN ARRAY ARRAY[21,45000] LOOP
    v_ok := false;
    BEGIN PERFORM agent_purchase_merchandise(v_cat, v_q, 'installment', NULL);
    EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'Maximum 20 units%'; END;
    IF NOT v_ok THEN RAISE EXCEPTION 'T7 qty % not refused (buy)', v_q; END IF;
    v_ok := false;
    BEGIN PERFORM agent_purchase_merchandise_plan(v_cat, v_q, NULL, 1);
    EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'Maximum 20 units%'; END;
    IF NOT v_ok THEN RAISE EXCEPTION 'T7 qty % not refused (plan)', v_q; END IF;
  END LOOP;
  v_ok := true;
  BEGIN
    PERFORM agent_purchase_merchandise_plan(v_cat, 20, NULL, 1);
    RAISE EXCEPTION 'undo_ok';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'Maximum 20 units%' THEN v_ok := false; END IF;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'T7 20 units refused'; END IF;

  v_r := agent_pay_merchandise_plan('eab6500c-cec5-401b-afc1-d20eac6ec378', 1000);
  IF v_r->>'error' IS DISTINCT FROM 'order_not_eligible' THEN RAISE EXCEPTION 'T8 pay now not blocked: %', v_r; END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  IF position('merchandise_plan_recovery_eligible' in pg_get_functiondef('public.recover_smartphone_from_wallets()'::regprocedure)) = 0 THEN RAISE EXCEPTION 'T9 phone guard missing'; END IF;
  IF position('merchandise_plan_recovery_eligible' in pg_get_functiondef('public.recover_merchandise_from_wallets(uuid,date)'::regprocedure)) = 0 THEN RAISE EXCEPTION 'T9 daily guard missing'; END IF;

  SELECT sum(outstanding_amount) INTO v_total FROM v_receivables_lines;
  IF v_total NOT BETWEEN 2100000000 AND 2250000000 THEN RAISE EXCEPTION 'T10 total %', v_total; END IF;

  SELECT count(*) INTO v_gl_after FROM general_ledger;
  IF v_gl_after <> v_gl_before THEN RAISE EXCEPTION 'T11 ledger rows created'; END IF;
  IF v_annet_sale <> (SELECT md5(row(s.*)::text) FROM merchandise_sales s WHERE id='9bc4e223-3f86-4b61-bc46-11904d443c58')
     OR v_annet_plan <> (SELECT md5(row(p.*)::text) FROM merchandise_recovery_plans p WHERE id='eab6500c-cec5-401b-afc1-d20eac6ec378')
  THEN RAISE EXCEPTION 'T11 Annet changed'; END IF;
  RAISE NOTICE 'All pre-release checks passed. Total receivables %', v_total;
END $t$;