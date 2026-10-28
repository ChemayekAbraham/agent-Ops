-- Recovery priority implementation. Apply only through the migration approval tool.
-- Existing collectors are patched in place, with signatures, grants and allocations preserved.
CREATE OR REPLACE FUNCTION public._bike_advance_priority_active(p_agent uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT EXISTS (SELECT 1 FROM public.agent_advances
   WHERE agent_id=p_agent AND status IN ('active','overdue') AND outstanding_balance>0
     AND NOT COALESCE(deduction_paused,false) AND COALESCE(recovery_source,'wallet_daily')<>'roi');
$$;
REVOKE ALL ON FUNCTION public._bike_advance_priority_active(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._bike_advance_priority_active(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._bike_priority_remaining(p_agent uuid, p_day date)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT COALESCE(sum(GREATEST(0, LEAST(p.outstanding_balance,
   GREATEST(COALESCE(b.daily,0),0)-COALESCE(d.paid,0)))),0)
 FROM public.merchandise_recovery_plans p
 CROSS JOIN LATERAL public._merch_bike_day(p.sale_id,COALESCE(p.pricing_basis,'')='spiro_28pct_v2',p_day) b
 LEFT JOIN LATERAL (SELECT sum(amount) paid FROM public.merchandise_recovery_deductions
   WHERE plan_id=p.id AND created_at >= p_day::timestamp AT TIME ZONE 'Africa/Kampala'
     AND created_at < (p_day+1)::timestamp AT TIME ZONE 'Africa/Kampala') d ON true
 WHERE p.customer_id=p_agent AND p.status='active' AND p.outstanding_balance>0
   AND COALESCE(p.is_bike_lease,false) AND NOT COALESCE(p.recovery_hold,false)
   AND (p.starts_on IS NULL OR p.starts_on<=p_day) AND b.active
   AND public.merchandise_plan_recovery_eligible(p.id);
$$;
REVOKE ALL ON FUNCTION public._bike_priority_remaining(uuid,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._bike_priority_remaining(uuid,date) TO service_role;

-- Isolated arithmetic seam for concrete priority regression tests; not a browser calculator.
CREATE OR REPLACE FUNCTION public._bike_priority_split(p_available numeric,p_quota numeric,p_paid numeric,p_outstanding numeric)
RETURNS TABLE(bike numeric,surplus numeric) LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT least(greatest(p_available,0),greatest(least(p_quota-p_paid,p_outstanding),0)),
   greatest(p_available-least(greatest(p_available,0),greatest(least(p_quota-p_paid,p_outstanding),0)),0);
$$;
REVOKE ALL ON FUNCTION public._bike_priority_split(numeric,numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._bike_priority_split(numeric,numeric,numeric,numeric) TO service_role;

-- A private scoped invocation of the existing bike collector: same ledger writer,
-- quota, principal/fee split and history. No new recovery scheduler or re-enabled earning trigger.
CREATE OR REPLACE FUNCTION public._prepare_bike_priority(p_agent uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_old text; v_result jsonb; v_test boolean; v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
 IF p_agent IS NULL THEN RAISE EXCEPTION 'Agent required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('bike_advance_waterfall:'||p_agent::text,0));
 IF EXISTS (SELECT 1 FROM public.treasury_controls WHERE
   (control_key='credits_paused' AND enabled) OR
   (control_key='maintenance_mode' AND enabled AND NOT EXISTS
     (SELECT 1 FROM public.treasury_controls WHERE control_key='maintenance_until'
       AND value IS NOT NULL AND value::timestamptz<=now()))) THEN
   RETURN 0;
 END IF;
 IF NOT public._bike_advance_priority_active(p_agent) THEN
   RETURN COALESCE(public.get_agent_sweepable_withdrawable(p_agent),0);
 END IF;
 IF public._bike_priority_remaining(p_agent,v_day)>0 THEN
   IF NOT COALESCE((SELECT enabled FROM public.treasury_controls WHERE control_key='merchandise_recovery_enabled'),false) THEN RETURN 0; END IF;
   v_old := current_setting('welile.bike_priority_agent',true);
   PERFORM set_config('welile.bike_priority_agent',p_agent::text,true);
   SELECT COALESCE(is_test,false) INTO v_test FROM public.profiles WHERE id=p_agent;
   v_result := public.recover_merchandise_from_wallets(CASE WHEN v_test THEN p_agent ELSE NULL END,NULL);
   PERFORM set_config('welile.bike_priority_agent',COALESCE(v_old,''),true);
   IF COALESCE((v_result->>'failures')::int,0)>0 OR v_result ? 'skipped' OR v_result ? 'disabled' THEN RETURN 0; END IF;
 END IF;
 IF public._bike_priority_remaining(p_agent,v_day)>0 THEN RETURN 0; END IF;
 RETURN COALESCE(public.get_agent_sweepable_withdrawable(p_agent),0);
END $$;
REVOKE ALL ON FUNCTION public._prepare_bike_priority(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._prepare_bike_priority(uuid) TO service_role;

-- Transform only known live collector statements; any drift aborts the entire migration.
DO $patch$
DECLARE d text; old text; new text;
BEGIN
 d := pg_get_functiondef('public.recover_merchandise_from_wallets(uuid,date)'::regprocedure);
 old := 'v_amount := floor(LEAST(v_due, v_cap_remaining, v_avail, v_plan.outstanding_balance));';
 new := E'SELECT x.bike INTO v_amount FROM public._bike_priority_split(floor(v_avail),v_cap_remaining,0,LEAST(v_due,v_plan.outstanding_balance)) x;';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Bike amount drift'; END IF; d := replace(d,old,new);
 old := 'AND CASE WHEN p_test_agent IS NULL THEN NOT COALESCE(pr.is_test, false) ELSE p.customer_id = p_test_agent END';
 new := old || E'\n      AND (NULLIF(current_setting(''welile.bike_priority_agent'',true),'''') IS NULL OR p.customer_id::text=current_setting(''welile.bike_priority_agent'',true))';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Bike scope drift'; END IF; d := replace(d,old,new);
 old := 'FOR UPDATE OF p SKIP LOCKED';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Bike lock drift'; END IF; d := replace(d,old,'');
 old := E'  LOOP\n    IF NOT public.merchandise_plan_recovery_eligible';
 new := E'  LOOP\n    IF NOT pg_try_advisory_xact_lock(hashtextextended(''bike_advance_waterfall:''||v_plan.customer_id::text,0)) THEN CONTINUE; END IF;\n    SELECT p.*, pr.full_name AS agent_name INTO v_plan FROM public.merchandise_recovery_plans p JOIN public.profiles pr ON pr.id=p.customer_id WHERE p.id=v_plan.id FOR UPDATE OF p;\n    IF v_plan.status<>''active'' OR v_plan.outstanding_balance<=0 OR COALESCE(v_plan.recovery_hold,false) THEN CONTINUE; END IF;\n    IF NOT public.merchandise_plan_recovery_eligible';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Bike refresh drift'; END IF; d := replace(d,old,new);
 old := 'v_cap_remaining := GREATEST(0, 2 * v_today_daily - v_taken_today);';
 new := E'v_cap_remaining := GREATEST(0, (CASE WHEN public._bike_advance_priority_active(v_plan.customer_id) THEN 1 ELSE 2 END) * v_today_daily - v_taken_today);';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Bike cap drift'; END IF; d := replace(d,old,new);
 old := 'v_avail := COALESCE(public.get_user_available_balance(v_plan.customer_id), 0);';
 new := 'v_avail := CASE WHEN public._bike_advance_priority_active(v_plan.customer_id) THEN COALESCE(public.get_agent_sweepable_withdrawable(v_plan.customer_id),0) ELSE COALESCE(public.get_user_available_balance(v_plan.customer_id),0) END;';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Bike available drift'; END IF; d := replace(d,old,new);
 EXECUTE d;

 d := pg_get_functiondef('public.sweep_agent_advance_recovery()'::regprocedure);
 old := E'AND COALESCE(recovery_source, ''wallet_daily'') <> ''roi''\n  LOOP';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Advance agent ordering drift'; END IF;
 d := replace(d,old,E'AND COALESCE(recovery_source, ''wallet_daily'') <> ''roi''\n    ORDER BY agent_id\n  LOOP');
 old := 'v_avail := COALESCE(public.get_agent_sweepable_withdrawable(v_agent.agent_id), 0);';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Advance sweep drift'; END IF;
 d := replace(d,old,'v_avail := public._prepare_bike_priority(v_agent.agent_id);');
 old := E'ORDER BY issued_at ASC\n    LOOP';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Advance sweep row-lock drift'; END IF;
 d := replace(d,old,E'ORDER BY issued_at ASC\n      FOR UPDATE\n    LOOP'); EXECUTE d;

 d := pg_get_functiondef('public.collect_due_agent_advance_installment(uuid)'::regprocedure);
 old := 'v_avail := COALESCE(public.get_agent_sweepable_withdrawable(p_agent_id), 0);';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Withdrawal collection drift'; END IF;
 d := replace(d,old,'v_avail := public._prepare_bike_priority(p_agent_id);');
 old := E'ORDER BY issued_at ASC\n  LOOP';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Withdrawal row-lock drift'; END IF;
 d := replace(d,old,E'ORDER BY issued_at ASC\n    FOR UPDATE\n  LOOP'); EXECUTE d;

 d := pg_get_functiondef('public.recover_agent_arrears_from_credit(uuid,numeric,uuid)'::regprocedure);
 old := 'v_available := COALESCE(public.get_user_available_balance(p_agent_id), 0);';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Earning recovery drift'; END IF;
 d := replace(d,old,'v_available := public._prepare_bike_priority(p_agent_id);');
 -- Do not restore the deliberately retired commission-interception trigger.
 EXECUTE d;

 d := pg_get_functiondef('public.record_advance_deduction_atomic(uuid,uuid,date,numeric,numeric,numeric,numeric,text,text,numeric,text,numeric,text,jsonb,text,jsonb)'::regprocedure);
 old := 'v_funding         jsonb;';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Atomic declaration drift'; END IF;
 d := replace(d,old,old||E'\n  v_current public.agent_advances%ROWTYPE;');
 old := E'  INSERT INTO public.agent_advance_ledger';
 new := E'  PERFORM public._prepare_bike_priority(p_agent_id);\n  SELECT * INTO v_current FROM public.agent_advances WHERE id=p_advance_id AND agent_id=p_agent_id FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION ''Advance owner mismatch'' USING ERRCODE=''42501''; END IF;\n  IF v_current.status NOT IN (''active'',''overdue'') OR COALESCE(v_current.deduction_paused,false) OR COALESCE(v_current.recovery_source,''wallet_daily'')=''roi'' THEN\n    RAISE EXCEPTION ''BIKE_PRIORITY_RECALCULATE: Advance eligibility changed'' USING ERRCODE=''40001'';\n  END IF;\n  IF p_opening_balance IS DISTINCT FROM v_current.outstanding_balance OR\n    (p_repayment_meta ? ''expected_arrears'' AND (p_repayment_meta->>''expected_arrears'')::numeric IS DISTINCT FROM COALESCE(v_current.arrears_balance,0)) THEN\n    RAISE EXCEPTION ''BIKE_PRIORITY_RECALCULATE: Advance changed; refresh recovery amounts'' USING ERRCODE=''40001'';\n  END IF;\n  IF COALESCE(p_amount_deducted,0)>public._prepare_bike_priority(p_agent_id) THEN\n    RAISE EXCEPTION ''BIKE_PRIORITY_RECALCULATE: Bike payment has priority; refresh recovery amounts'' USING ERRCODE=''40001'';\n  END IF;\n  INSERT INTO public.agent_advance_ledger';
 IF strpos(d,old)=0 THEN RAISE EXCEPTION 'Atomic deduction drift'; END IF;
 d := replace(d,old,new); EXECUTE d;
END $patch$;

CREATE OR REPLACE FUNCTION public.agent_bike_advance_priority(p_agent_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date; v_daily numeric; v_paid numeric; v_advance numeric; v_enabled boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_mfa_ok() OR
   (auth.uid()<>p_agent_id AND NOT public.can_review_bike_leases(auth.uid())) THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 SELECT COALESCE(sum(LEAST(GREATEST(COALESCE(b.daily,0),0),p.outstanding_balance+COALESCE(d.paid,0))),0),
   COALESCE(sum(COALESCE(d.paid,0)),0) INTO v_daily,v_paid
 FROM public.merchandise_recovery_plans p
 CROSS JOIN LATERAL public._merch_bike_day(p.sale_id,COALESCE(p.pricing_basis,'')='spiro_28pct_v2',v_day) b
 LEFT JOIN LATERAL (SELECT sum(amount) paid FROM public.merchandise_recovery_deductions
   WHERE plan_id=p.id AND created_at>=v_day::timestamp AT TIME ZONE 'Africa/Kampala'
   AND created_at<(v_day+1)::timestamp AT TIME ZONE 'Africa/Kampala') d ON true
 WHERE p.customer_id=p_agent_id AND (p.status='active' OR (p.status='completed' AND COALESCE(d.paid,0)>0))
   AND COALESCE(p.is_bike_lease,false) AND NOT COALESCE(p.recovery_hold,false)
   AND (p.starts_on IS NULL OR p.starts_on<=v_day)
   AND b.active AND public.merchandise_plan_recovery_eligible(p.id);
 SELECT COALESCE(sum(outstanding_balance),0) INTO v_advance FROM public.agent_advances
 WHERE agent_id=p_agent_id AND status IN ('active','overdue') AND outstanding_balance>0
   AND NOT COALESCE(deduction_paused,false) AND COALESCE(recovery_source,'wallet_daily')<>'roi';
 SELECT COALESCE(enabled,false) INTO v_enabled FROM public.treasury_controls WHERE control_key='merchandise_recovery_enabled';
 IF EXISTS (SELECT 1 FROM public.treasury_controls WHERE
   (control_key='credits_paused' AND enabled) OR
   (control_key='maintenance_mode' AND enabled AND NOT EXISTS
     (SELECT 1 FROM public.treasury_controls WHERE control_key='maintenance_until'
       AND value IS NOT NULL AND value::timestamptz<=now()))) THEN v_enabled := false; END IF;
 RETURN jsonb_build_object('day',v_day,'protected',COALESCE(v_enabled,false),
   'bike_daily',v_daily,'bike_paid_today',v_paid,'bike_remaining_today',public._bike_priority_remaining(p_agent_id,v_day),
   'advance_outstanding',v_advance,'advance_from_surplus',v_advance>0,'applicable',v_daily>0 AND v_advance>0);
END $$;
REVOKE ALL ON FUNCTION public.agent_bike_advance_priority(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.agent_bike_advance_priority(uuid) TO authenticated,service_role;