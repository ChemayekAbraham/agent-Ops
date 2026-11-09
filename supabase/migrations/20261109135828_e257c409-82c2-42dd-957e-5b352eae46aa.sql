CREATE OR REPLACE FUNCTION public._welile_signages_cfo_activation_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_payout boolean := coalesce(current_setting('welile.signage_payout',true),'')='on';
 v_agent_install boolean := coalesce(current_setting('welile.signage_agent_install',true),'')='on';
 v_ops boolean := public._has_enabled_role(auth.uid(),ARRAY['agent_ops','operations','manager','super_admin','admin','ceo']) AND public.staff_mfa_ok();
 v_paid boolean;
BEGIN
 IF TG_OP='INSERT' THEN NEW.owner_rent_due_at:=NULL; RETURN NEW; END IF;
 IF NOT v_payout THEN NEW.owner_rent_due_at:=OLD.owner_rent_due_at; END IF;
 v_paid := EXISTS(SELECT 1 FROM public.welile_signage_payments WHERE signage_id=NEW.id AND payout_type='agent_reward' AND period_index=0) AND EXISTS(SELECT 1 FROM public.welile_signage_payments WHERE signage_id=NEW.id AND payout_type='owner_rent' AND period_index=0);
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
  NEW.activated_at:=OLD.activated_at; NEW.verified_by:=OLD.verified_by; NEW.verified_at:=OLD.verified_at;
  IF NOT v_agent_install AND NOT v_ops THEN NEW.installation_started_at:=OLD.installation_started_at; NEW.installation_submitted_at:=OLD.installation_submitted_at; NEW.installation_decline_reason:=OLD.installation_decline_reason; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status='awaiting_cfo' THEN
  IF OLD.status='awaiting_coo' THEN NULL;
  ELSIF OLD.status IN ('approved_for_installation','pending_installation','installation_in_progress','installation_verification') AND v_ops THEN NULL;
  ELSE RAISE EXCEPTION 'Only a COO approval sends a signage to the CFO'; END IF;
  NEW.activated_at:=NULL; NEW.agent_reward_status:='eligible'; NEW.owner_rent_status:='pending';
 ELSIF NEW.status IN ('installation_in_progress','installation_verification') THEN
  RAISE EXCEPTION 'The installation step has been removed. Signages activate when the CFO pays.';
 ELSIF NEW.status='active' THEN
  IF OLD.status<>'awaiting_cfo' OR NOT v_payout THEN RAISE EXCEPTION 'Signage activates only when the CFO disburses both initial payments'; END IF;
  IF NOT v_paid THEN RAISE EXCEPTION 'Both the agent reward and first owner rent must be paid before activation'; END IF;
  NEW.verified_by:=OLD.verified_by; NEW.verified_at:=OLD.verified_at;
  NEW.activated_at:=now(); NEW.installation_decline_reason:=NULL;
  NEW.owner_rent_due_at:=((now() AT TIME ZONE 'Africa/Kampala')+interval '1 month') AT TIME ZONE 'Africa/Kampala';
 ELSE
  NEW.activated_at:=OLD.activated_at; NEW.verified_by:=OLD.verified_by; NEW.verified_at:=OLD.verified_at;
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public._welile_signages_evidence_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='INSERT' OR (OLD.status='changes_required' AND NEW.status='submitted') THEN
  IF NEW.gps_source IS DISTINCT FROM 'device' OR NEW.gps_latitude IS NULL OR NEW.gps_longitude IS NULL OR NEW.gps_latitude NOT BETWEEN -90 AND 90 OR NEW.gps_longitude NOT BETWEEN -180 AND 180 OR NEW.gps_accuracy_meters IS NULL OR NEW.gps_accuracy_meters < 0 OR NEW.gps_captured_at IS NULL THEN
   RAISE EXCEPTION 'Real device GPS is required. Stand at the property and capture GPS again.';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.status='active' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.review_notes IS DISTINCT FROM OLD.review_notes OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason OR NEW.coo_review_notes IS DISTINCT FROM OLD.coo_review_notes OR NEW.photos IS DISTINCT FROM OLD.photos OR NEW.installation_photos IS DISTINCT FROM OLD.installation_photos OR NEW.installed_at IS DISTINCT FROM OLD.installed_at OR NEW.installer_name IS DISTINCT FROM OLD.installer_name OR NEW.verification_notes IS DISTINCT FROM OLD.verification_notes) THEN
  RAISE EXCEPTION 'Active signages are read-only in Ops review.';
 END IF;
 IF TG_OP='INSERT' OR NEW.owner_phone IS DISTINCT FROM OLD.owner_phone THEN
  NEW.repeat_owner_phone := EXISTS(SELECT 1 FROM public.welile_signages s WHERE s.id<>NEW.id AND right(regexp_replace(s.owner_phone,'[^0-9]','','g'),9)=right(regexp_replace(NEW.owner_phone,'[^0-9]','','g'),9));
 ELSE
  NEW.repeat_owner_phone := OLD.repeat_owner_phone;
 END IF;
 RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION signage_internal.cfo_disburse_signage(p_signage_id uuid, p_payout_type text, p_period_index integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid:=auth.uid(); v_s public.welile_signages; v_payment public.welile_signage_payments; v_recipient uuid; v_matches integer; v_amount numeric; v_ref text; v_group uuid; v_next integer; v_due timestamptz; v_digits text; v_flag text:=coalesce(current_setting('welile.signage_payout',true),'');
BEGIN
 IF v_uid IS NULL OR NOT public._has_enabled_role(v_uid,ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the CFO can disburse signage payments' USING ERRCODE='42501'; END IF;
 IF p_payout_type IS NULL OR p_payout_type NOT IN ('agent_reward','owner_rent') OR p_period_index IS NULL OR p_period_index<0 OR (p_payout_type='agent_reward' AND p_period_index<>0) THEN RAISE EXCEPTION 'Invalid signage payout type or period'; END IF;
 SELECT * INTO v_s FROM public.welile_signages WHERE id=p_signage_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;
 SELECT * INTO v_payment FROM public.welile_signage_payments WHERE signage_id=p_signage_id AND payout_type=p_payout_type AND period_index=p_period_index;
 IF FOUND THEN RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'amount_ugx',v_payment.amount_ugx,'reference_id',v_payment.reference_id,'recipient_id',v_payment.recipient_id,'ledger_group_id',v_payment.ledger_group_id,'already_paid',true); END IF;
 IF v_s.status NOT IN ('awaiting_cfo','active') OR v_s.coo_approved_at IS NULL AND v_s.verified_at IS NULL THEN RAISE EXCEPTION 'Only COO-approved signages awaiting the CFO can be paid'; END IF;
 IF p_payout_type='agent_reward' THEN
  IF v_s.agent_reward_status='paid' THEN RAISE EXCEPTION 'Agent reward is already paid'; END IF;
  v_recipient:=v_s.agent_id; v_amount:=3000;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=v_recipient AND deleted_at IS NULL) THEN RAISE EXCEPTION 'The agent Welile account is unavailable'; END IF;
 ELSE
  v_amount:=10000;
  SELECT coalesce(max(period_index)+1,0) INTO v_next FROM public.welile_signage_payments WHERE signage_id=p_signage_id AND payout_type='owner_rent';
  IF v_next=0 AND v_s.owner_rent_status='paid' THEN v_next:=1; END IF;
  IF p_period_index<>v_next THEN RAISE EXCEPTION 'Owner rent period has changed. Refresh the queue.'; END IF;
  IF p_period_index>0 THEN
   IF v_s.status<>'active' OR v_s.activated_at IS NULL THEN RAISE EXCEPTION 'Recurring owner rent requires an active signage'; END IF;
   v_due:=((v_s.activated_at AT TIME ZONE 'Africa/Kampala')+make_interval(months=>p_period_index)) AT TIME ZONE 'Africa/Kampala';
   IF v_due>now() THEN RAISE EXCEPTION 'This monthly owner rent is not due yet'; END IF;
  END IF;
  v_digits:=regexp_replace(coalesce(nullif(v_s.owner_payment_number,''),v_s.owner_phone),'[^0-9]','','g');
  IF length(v_digits)<9 OR length(v_digits)>12 THEN RAISE EXCEPTION 'A valid owner payment phone number is required to find their Welile wallet'; END IF;
  SELECT count(*),(array_agg(id))[1] INTO v_matches,v_recipient FROM public.profiles WHERE deleted_at IS NULL AND right(regexp_replace(phone,'[^0-9]','','g'),9)=right(v_digits,9);
  IF v_matches<>1 THEN RAISE EXCEPTION 'Owner payment number must match exactly one existing Welile account. Please review the owner details.'; END IF;
 END IF;
 v_ref:='signage:'||p_signage_id||':'||p_payout_type||':'||p_period_index;
 v_group:=public.create_ledger_transaction(jsonb_build_array(
  jsonb_build_object('user_id',v_recipient,'amount',v_amount,'direction','cash_in','category',CASE WHEN p_payout_type='agent_reward' THEN 'agent_bonus' ELSE 'wallet_deposit' END,'ledger_scope','wallet','recipient_type','user','wallet_bucket','withdrawable','source_table','welile_signage_payments','source_id',p_signage_id,'reference_id',v_ref,'currency','UGX','description',CASE WHEN p_payout_type='agent_reward' THEN 'Welile Signages one-time agent reward' ELSE 'Welile Signages owner rent, month '||p_period_index END),
  jsonb_build_object('user_id',v_recipient,'amount',v_amount,'direction','cash_out','category','marketing_expense','ledger_scope','platform','source_table','welile_signage_payments','source_id',p_signage_id,'reference_id',v_ref,'currency','UGX','description','Welile Signages '||p_payout_type||' for '||v_s.reference_no)
 ),v_ref);
 IF NOT EXISTS(SELECT 1 FROM public.general_ledger WHERE transaction_group_id=v_group AND user_id=v_recipient AND ledger_scope='wallet' AND direction='cash_in' AND amount=v_amount AND reference_id=v_ref) THEN RAISE EXCEPTION 'Wallet disbursement could not be confirmed'; END IF;
 PERFORM set_config('welile.signage_payout','on',true);
 INSERT INTO public.welile_signage_payments(signage_id,payout_type,period_index,recipient_id,amount_ugx,ledger_group_id,reference_id,paid_by) VALUES(p_signage_id,p_payout_type,p_period_index,v_recipient,v_amount,v_group,v_ref,v_uid);
 UPDATE public.welile_signages SET
  agent_reward_status=CASE WHEN p_payout_type='agent_reward' THEN 'paid' ELSE agent_reward_status END,
  agent_reward_tx_ref=CASE WHEN p_payout_type='agent_reward' THEN v_ref ELSE agent_reward_tx_ref END,
  agent_reward_disbursed_at=CASE WHEN p_payout_type='agent_reward' THEN now() ELSE agent_reward_disbursed_at END,
  agent_reward_disbursed_by=CASE WHEN p_payout_type='agent_reward' THEN v_uid ELSE agent_reward_disbursed_by END,
  owner_rent_status=CASE WHEN p_payout_type='owner_rent' THEN 'paid' ELSE owner_rent_status END,
  owner_rent_tx_ref=CASE WHEN p_payout_type='owner_rent' THEN v_ref ELSE owner_rent_tx_ref END,
  owner_rent_disbursed_at=CASE WHEN p_payout_type='owner_rent' THEN now() ELSE owner_rent_disbursed_at END,
  owner_rent_disbursed_by=CASE WHEN p_payout_type='owner_rent' THEN v_uid ELSE owner_rent_disbursed_by END,
  owner_rent_due_at=CASE WHEN p_payout_type='owner_rent' AND activated_at IS NOT NULL THEN ((activated_at AT TIME ZONE 'Africa/Kampala')+make_interval(months=>p_period_index+1)) AT TIME ZONE 'Africa/Kampala' ELSE owner_rent_due_at END
 WHERE id=p_signage_id RETURNING * INTO v_s;
 IF v_s.status='awaiting_cfo' AND v_s.agent_reward_status='paid' AND v_s.owner_rent_status='paid' THEN
  UPDATE public.welile_signages SET status='active' WHERE id=p_signage_id RETURNING * INTO v_s;
 END IF;
 INSERT INTO public.system_events(event_type,user_id,related_entity_type,related_entity_id,metadata,actor_id) VALUES('welile_signage_payment_disbursed',v_recipient,'welile_signages',p_signage_id,jsonb_build_object('payout_type',p_payout_type,'amount_ugx',v_amount,'period_index',p_period_index,'reference_id',v_ref,'ledger_group_id',v_group),v_uid);
 INSERT INTO public.audit_logs(user_id,action_type,table_name,record_id,reason,new_values,performed_by) VALUES(v_uid,'signage_payment_disbursed','welile_signages',p_signage_id,'CFO authorized signage wallet disbursement',jsonb_build_object('payout_type',p_payout_type,'amount_ugx',v_amount,'reference_id',v_ref),v_uid);
 PERFORM public.recompute_trust_score(v_recipient);
 PERFORM set_config('welile.signage_payout',v_flag,true);
 RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'amount_ugx',v_amount,'recipient_id',v_recipient,'reference_id',v_ref,'ledger_group_id',v_group,'already_paid',false);
END $function$;

CREATE OR REPLACE FUNCTION public.cfo_signages_queue()
 RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'public'
AS $function$
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the CFO can view the signage disbursement queue' USING ERRCODE='42501'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC),'[]'::jsonb) FROM (
 SELECT s.id,s.reference_no,s.agent_id,s.agent_name,s.agent_phone,s.property_name,s.property_type,s.owner_full_name,s.owner_phone,s.owner_payment_method,s.owner_payment_number,s.owner_payment_name,s.gps_latitude,s.gps_longitude,s.gps_accuracy_meters,s.district_name,s.village_name,s.repeat_owner_phone,s.status,s.installed_at,s.installer_name,s.verified_by,s.verified_at,s.verification_notes,s.activated_at,s.coo_approved_at,s.agent_reward_status,s.agent_reward_disbursed_at,s.agent_reward_tx_ref,s.owner_rent_status,s.owner_rent_disbursed_at,s.owner_rent_tx_ref,s.created_at,s.updated_at,
 coalesce(s.owner_rent_due_at,CASE WHEN s.status='active' AND s.owner_rent_status='paid' THEN ((s.activated_at AT TIME ZONE 'Africa/Kampala')+interval '1 month') AT TIME ZONE 'Africa/Kampala' END) AS owner_rent_due_at,
 coalesce((SELECT max(p.period_index)+1 FROM public.welile_signage_payments p WHERE p.signage_id=s.id AND p.payout_type='owner_rent'),CASE WHEN s.owner_rent_status='paid' THEN 1 ELSE 0 END) AS owner_rent_period_index,
 (s.status IN ('awaiting_cfo','active') AND (s.coo_approved_at IS NOT NULL OR s.verified_at IS NOT NULL) AND
 (s.owner_rent_status<>'paid' OR coalesce(s.owner_rent_due_at,((s.activated_at AT TIME ZONE 'Africa/Kampala')+interval '1 month') AT TIME ZONE 'Africa/Kampala')<=now())) AS owner_rent_payable,
 (s.status IN ('awaiting_cfo','active') AND (s.coo_approved_at IS NOT NULL OR s.verified_at IS NOT NULL)) AS installation_payment_eligible
 FROM public.welile_signages s WHERE s.status IN ('awaiting_cfo','active')
 ) q);
END $function$;

CREATE OR REPLACE FUNCTION public.my_signage_installations_due()
 RETURNS TABLE(id uuid, reference_no text, property_name text, installation_started_at timestamp with time zone, installation_decline_reason text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
 SELECT s.id, s.reference_no, s.property_name, s.installation_started_at, s.installation_decline_reason
 FROM public.welile_signages s WHERE false
$function$;