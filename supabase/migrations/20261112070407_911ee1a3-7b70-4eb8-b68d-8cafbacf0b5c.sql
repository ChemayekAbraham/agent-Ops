DO $migration$
DECLARE body text;
BEGIN
 SELECT pg_get_functiondef('public._welile_signages_cfo_activation_guard()'::regprocedure) INTO body;
 IF position('Signage activates only when the CFO disburses both initial payments' in body)=0 THEN RAISE EXCEPTION 'Unexpected activation guard definition'; END IF;
 body:=replace(body, 'IF OLD.status<>''awaiting_cfo'' OR NOT v_payout THEN RAISE EXCEPTION ''Signage activates only when the CFO disburses both initial payments''; END IF;', 'IF OLD.status<>''awaiting_cfo'' OR coalesce(current_setting(''welile.signage_cfo_approval'',true),'''')<>''on'' THEN RAISE EXCEPTION ''Signage activates only after CFO approval''; END IF;');
 body:=replace(body, 'IF NOT v_paid THEN RAISE EXCEPTION ''Both the agent reward and first owner rent must be paid before activation''; END IF;', 'IF NOT public._has_enabled_role(auth.uid(),ARRAY[''cfo'',''super_admin'']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION ''Only the CFO can activate signage'' USING ERRCODE=''42501''; END IF;');
 body:=replace(body, 'NEW.owner_rent_due_at:=((now() AT TIME ZONE ''Africa/Kampala'')+interval ''1 month'') AT TIME ZONE ''Africa/Kampala'';', 'NEW.owner_rent_due_at:=NEW.created_at+interval ''30 days'';');
 EXECUTE body;
 SELECT pg_get_functiondef('signage_internal.cfo_disburse_signage(uuid,text,integer)'::regprocedure) INTO body;
 IF position('IF p_period_index>0 THEN' in body)=0 THEN RAISE EXCEPTION 'Unexpected payout definition'; END IF;
 body:=replace(body, 'v_amount:=10000;', 'v_amount:=10000; IF v_s.status<>''active'' OR v_s.created_at IS NULL OR now()<v_s.created_at+interval ''30 days'' THEN RAISE EXCEPTION ''Owner monthly payout is available only for an active signage at least 30 days after submission''; END IF;');
 body:=replace(body, 'v_due:=((v_s.activated_at AT TIME ZONE ''Africa/Kampala'')+make_interval(months=>p_period_index)) AT TIME ZONE ''Africa/Kampala'';', 'v_due:=coalesce(v_s.owner_rent_due_at,((v_s.created_at+interval ''30 days'') AT TIME ZONE ''Africa/Kampala''+make_interval(months=>p_period_index)) AT TIME ZONE ''Africa/Kampala'');');
 body:=replace(body, '((activated_at AT TIME ZONE ''Africa/Kampala'')+make_interval(months=>p_period_index+1)) AT TIME ZONE ''Africa/Kampala''', '((coalesce(owner_rent_due_at,created_at+interval ''30 days'') AT TIME ZONE ''Africa/Kampala'')+interval ''1 month'') AT TIME ZONE ''Africa/Kampala''');
 body:=replace(body, 'IF v_s.status=''awaiting_cfo'' AND v_s.agent_reward_status=''paid'' AND v_s.owner_rent_status=''paid'' THEN
  UPDATE public.welile_signages SET status=''active'' WHERE id=p_signage_id RETURNING * INTO v_s;
 END IF;', '');
 EXECUTE body;
END $migration$;

CREATE OR REPLACE FUNCTION public.cfo_approve_signage(p_signage_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE s public.welile_signages; old_flag text:=coalesce(current_setting('welile.signage_cfo_approval',true),''); old_payout text:=coalesce(current_setting('welile.signage_payout',true),'');
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the CFO can approve signage' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.welile_signages WHERE id=p_signage_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;
 IF s.status='active' THEN RETURN jsonb_build_object('signage_id',s.id,'status',s.status,'already_approved',true); END IF;
 IF s.status<>'awaiting_cfo' OR s.coo_approved_at IS NULL THEN RAISE EXCEPTION 'This application is not awaiting CFO approval'; END IF;
 PERFORM set_config('welile.signage_cfo_approval','on',true);
 PERFORM set_config('welile.signage_payout','on',true);
 UPDATE public.welile_signages SET status='active' WHERE id=p_signage_id RETURNING * INTO s;
 PERFORM set_config('welile.signage_cfo_approval',old_flag,true);
 PERFORM set_config('welile.signage_payout',old_payout,true);
 PERFORM public.recompute_trust_score(s.agent_id);
 RETURN jsonb_build_object('signage_id',s.id,'status',s.status,'already_approved',false);
END $function$;
REVOKE ALL ON FUNCTION public.cfo_approve_signage(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cfo_approve_signage(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.cfo_signages_queue() RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $function$
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the CFO can view the signage disbursement queue' USING ERRCODE='42501'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC),'[]'::jsonb) FROM (
 SELECT s.id,s.reference_no,s.agent_id,s.agent_name,s.agent_phone,s.property_name,s.property_type,s.owner_full_name,s.owner_phone,s.owner_payment_method,s.owner_payment_number,s.owner_payment_name,s.gps_latitude,s.gps_longitude,s.gps_accuracy_meters,s.district_name,s.village_name,s.repeat_owner_phone,s.status,s.installed_at,s.installer_name,s.verified_by,s.verified_at,s.verification_notes,s.activated_at,s.coo_approved_at,s.agent_reward_status,s.agent_reward_disbursed_at,s.agent_reward_tx_ref,s.owner_rent_status,s.owner_rent_disbursed_at,s.owner_rent_tx_ref,s.created_at,s.updated_at,
 greatest(s.created_at+interval '30 days',coalesce(s.owner_rent_due_at,s.created_at+interval '30 days')) as owner_rent_due_at,
 coalesce((SELECT max(p.period_index)+1 FROM public.welile_signage_payments p WHERE p.signage_id=s.id AND p.payout_type='owner_rent'),CASE WHEN s.owner_rent_status='paid' THEN 1 ELSE 0 END) as owner_rent_period_index,
 (s.status='active' AND (s.coo_approved_at IS NOT NULL OR s.verified_at IS NOT NULL) AND s.created_at+interval '30 days'<=now() AND (s.owner_rent_status<>'paid' OR coalesce(s.owner_rent_due_at,s.created_at+interval '30 days')<=now())) as owner_rent_payable,
 (s.status IN ('awaiting_cfo','active') AND (s.coo_approved_at IS NOT NULL OR s.verified_at IS NOT NULL)) as installation_payment_eligible
 FROM public.welile_signages s WHERE s.status IN ('awaiting_cfo','active')
 ) q);
END $function$;