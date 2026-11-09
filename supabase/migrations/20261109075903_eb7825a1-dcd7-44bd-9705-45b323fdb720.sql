ALTER TABLE public.welile_signages DROP CONSTRAINT welile_signages_status_check;
ALTER TABLE public.welile_signages ADD CONSTRAINT welile_signages_status_check CHECK (status = ANY (ARRAY['draft','submitted','pending','under_review','changes_required','awaiting_coo','rejected','approved_for_installation','pending_installation','installation_verification','awaiting_cfo','active','temporarily_inactive','payment_on_hold','removal_requested','removed','cancelled']::text[]));
ALTER TABLE public.welile_signages ADD COLUMN owner_rent_due_at timestamptz;

CREATE TABLE public.welile_signage_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 signage_id uuid NOT NULL REFERENCES public.welile_signages(id),
 payout_type text NOT NULL,
 period_index integer NOT NULL,
 recipient_id uuid NOT NULL,
 amount_ugx numeric NOT NULL,
 ledger_group_id uuid NOT NULL,
 reference_id text NOT NULL UNIQUE,
 paid_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(signage_id,payout_type,period_index)
);
GRANT SELECT ON public.welile_signage_payments TO authenticated;
GRANT ALL ON public.welile_signage_payments TO service_role;
ALTER TABLE public.welile_signage_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY signage_payment_read ON public.welile_signage_payments FOR SELECT TO authenticated USING (
 (SELECT public.welile_signages_ops_ok()) OR recipient_id=(SELECT auth.uid()) OR EXISTS(SELECT 1 FROM public.welile_signages s WHERE s.id=signage_id AND s.agent_id=(SELECT auth.uid()))
);
CREATE POLICY mfa_required_for_staff ON public.welile_signage_payments AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

CREATE FUNCTION public._welile_signage_payments_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Signage payments are append-only'; END IF;
 IF coalesce(current_setting('welile.signage_payout',true),'') <> 'on' OR auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the CFO payment process may record signage payments'; END IF;
 IF NOT ((NEW.payout_type='agent_reward' AND NEW.period_index=0 AND NEW.amount_ugx=3000) OR (NEW.payout_type='owner_rent' AND NEW.period_index>=0 AND NEW.amount_ugx=10000)) THEN RAISE EXCEPTION 'Invalid signage payment amount or period'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER signage_payments_append_only BEFORE INSERT OR UPDATE OR DELETE ON public.welile_signage_payments FOR EACH ROW EXECUTE FUNCTION public._welile_signage_payments_guard();

CREATE FUNCTION public._welile_signages_cfo_activation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_payout boolean := coalesce(current_setting('welile.signage_payout',true),'')='on';
BEGIN
 IF TG_OP='INSERT' THEN NEW.owner_rent_due_at:=NULL; RETURN NEW; END IF;
 IF NOT v_payout THEN NEW.owner_rent_due_at:=OLD.owner_rent_due_at; END IF;
 IF NEW.status='awaiting_cfo' AND OLD.status IS DISTINCT FROM 'awaiting_cfo' THEN
  IF OLD.status NOT IN ('approved_for_installation','pending_installation','installation_verification') OR NOT public._has_enabled_role(auth.uid(),ARRAY['agent_ops','operations','manager','super_admin','admin','ceo']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only Agent Ops can verify a COO-approved installation'; END IF;
  IF NEW.installed_at IS NULL OR length(trim(coalesce(NEW.installer_name,'')))=0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(NEW.installation_photos,'[]'::jsonb)) p WHERE p->>'category'='installed_signage' AND coalesce(p->>'url','') ~ '^(data:image/(webp|jpeg|png);base64,|https://)') THEN RAISE EXCEPTION 'An installation date, installer and installed-board photo are required'; END IF;
  IF NEW.installed_at > (now() AT TIME ZONE 'Africa/Kampala')::date THEN RAISE EXCEPTION 'Installation date cannot be in the future'; END IF;
  NEW.verified_by:=auth.uid(); NEW.verified_at:=now(); NEW.activated_at:=NULL;
  NEW.agent_reward_status:='eligible'; NEW.owner_rent_status:='pending';
 ELSIF NEW.status='active' AND OLD.status IS DISTINCT FROM 'active' THEN
  IF NOT v_payout OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() OR OLD.status<>'awaiting_cfo' THEN RAISE EXCEPTION 'Signage activates only after CFO disbursement of both initial payments'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.welile_signage_payments WHERE signage_id=NEW.id AND payout_type='agent_reward' AND period_index=0) OR NOT EXISTS(SELECT 1 FROM public.welile_signage_payments WHERE signage_id=NEW.id AND payout_type='owner_rent' AND period_index=0) THEN RAISE EXCEPTION 'Both the agent reward and first owner rent must be paid before activation'; END IF;
  NEW.verified_by:=OLD.verified_by; NEW.verified_at:=OLD.verified_at; NEW.activated_at:=now();
  NEW.owner_rent_due_at:=((now() AT TIME ZONE 'Africa/Kampala')+interval '1 month') AT TIME ZONE 'Africa/Kampala';
 ELSE
  NEW.activated_at:=OLD.activated_at; NEW.verified_by:=OLD.verified_by; NEW.verified_at:=OLD.verified_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_zzz_signages_cfo_activation BEFORE INSERT OR UPDATE ON public.welile_signages FOR EACH ROW EXECUTE FUNCTION public._welile_signages_cfo_activation_guard();

CREATE FUNCTION public.cfo_disburse_signage(p_signage_id uuid,p_payout_type text,p_period_index integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid uuid:=auth.uid(); v_s public.welile_signages; v_payment public.welile_signage_payments; v_recipient uuid; v_matches integer; v_amount numeric; v_ref text; v_group uuid; v_next integer; v_due timestamptz; v_digits text; v_flag text:=coalesce(current_setting('welile.signage_payout',true),'');
BEGIN
 IF v_uid IS NULL OR NOT public._has_enabled_role(v_uid,ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the CFO can disburse signage payments' USING ERRCODE='42501'; END IF;
 IF p_payout_type IS NULL OR p_payout_type NOT IN ('agent_reward','owner_rent') OR p_period_index IS NULL OR p_period_index<0 OR (p_payout_type='agent_reward' AND p_period_index<>0) THEN RAISE EXCEPTION 'Invalid signage payout type or period'; END IF;
 SELECT * INTO v_s FROM public.welile_signages WHERE id=p_signage_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;
 SELECT * INTO v_payment FROM public.welile_signage_payments WHERE signage_id=p_signage_id AND payout_type=p_payout_type AND period_index=p_period_index;
 IF FOUND THEN RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'amount_ugx',v_payment.amount_ugx,'reference_id',v_payment.reference_id,'recipient_id',v_payment.recipient_id,'ledger_group_id',v_payment.ledger_group_id,'already_paid',true); END IF;
 IF v_s.status NOT IN ('awaiting_cfo','active') OR v_s.verified_at IS NULL OR v_s.installed_at IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_s.installation_photos,'[]'::jsonb)) p WHERE p->>'category'='installed_signage' AND coalesce(p->>'url','') ~ '^(data:image/(webp|jpeg|png);base64,|https://)') THEN RAISE EXCEPTION 'Verified installation and installed-board evidence are required before payment'; END IF;
 IF p_payout_type='agent_reward' THEN
  IF v_s.agent_reward_status='paid' THEN RAISE EXCEPTION 'Agent reward is already paid'; END IF;
  v_recipient:=v_s.agent_id; v_amount:=3000;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=v_recipient AND deleted_at IS NULL) THEN RAISE EXCEPTION 'The agent Welile account is unavailable'; END IF;
 ELSE
  v_amount:=10000;
  SELECT coalesce(max(period_index)+1,0) INTO v_next FROM public.welile_signage_payments WHERE signage_id=p_signage_id AND payout_type='owner_rent';
  -- Existing active records with a historical paid stamp start at the next anniversary, never pay their initial rent twice.
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
 IF v_s.status='awaiting_cfo' AND v_s.agent_reward_status='paid' AND v_s.owner_rent_status='paid' THEN UPDATE public.welile_signages SET status='active' WHERE id=p_signage_id RETURNING * INTO v_s; END IF;
 INSERT INTO public.system_events(event_type,user_id,related_entity_type,related_entity_id,metadata,actor_id) VALUES('welile_signage_payment_disbursed',v_recipient,'welile_signages',p_signage_id,jsonb_build_object('payout_type',p_payout_type,'amount_ugx',v_amount,'period_index',p_period_index,'reference_id',v_ref,'ledger_group_id',v_group),v_uid);
 INSERT INTO public.audit_logs(user_id,action_type,table_name,record_id,reason,new_values,performed_by) VALUES(v_uid,'signage_payment_disbursed','welile_signages',p_signage_id,'CFO authorized signage wallet disbursement',jsonb_build_object('payout_type',p_payout_type,'amount_ugx',v_amount,'reference_id',v_ref),v_uid);
 PERFORM public.recompute_trust_score(v_recipient);
 PERFORM set_config('welile.signage_payout',v_flag,true);
 RETURN jsonb_build_object('signage_id',v_s.id,'status',v_s.status,'amount_ugx',v_amount,'recipient_id',v_recipient,'reference_id',v_ref,'ledger_group_id',v_group,'already_paid',false);
END $$;
REVOKE ALL ON FUNCTION public.cfo_disburse_signage(uuid,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cfo_disburse_signage(uuid,text,integer) TO authenticated,service_role;
