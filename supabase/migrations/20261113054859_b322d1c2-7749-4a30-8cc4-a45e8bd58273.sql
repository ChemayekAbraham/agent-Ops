CREATE TABLE public.partner_agreement_rate_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid NOT NULL REFERENCES public.profiles(id),
 requested_rate numeric NOT NULL CHECK(requested_rate>0 AND requested_rate<=100), rate_in_force numeric NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','approved','rejected','superseded')),
 requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(), decided_by uuid, decided_at timestamptz,
 decision_note text, portfolio_id uuid REFERENCES public.investor_portfolios(id), applied_at timestamptz, applied_xact bigint,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.partner_agreement_rate_requests TO authenticated;
GRANT ALL ON public.partner_agreement_rate_requests TO service_role;
ALTER TABLE public.partner_agreement_rate_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_read ON public.partner_agreement_rate_requests FOR SELECT TO authenticated USING ((select public._partner_return_policy_caller_ok(ARRAY['cfo','ceo','coo','manager','super_admin','partner_ops','financial_ops'])));
CREATE POLICY mfa_required_for_staff ON public.partner_agreement_rate_requests AS RESTRICTIVE FOR ALL TO authenticated USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE UNIQUE INDEX partner_agreement_rate_one_open ON public.partner_agreement_rate_requests(partner_id) WHERE status IN ('pending','approved') AND applied_at IS NULL;
CREATE FUNCTION public._agreement_rate_timestamp() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN NEW.updated_at:=now(); RETURN NEW; END $$;
CREATE TRIGGER agreement_rate_timestamp BEFORE UPDATE ON public.partner_agreement_rate_requests FOR EACH ROW EXECUTE FUNCTION public._agreement_rate_timestamp();
REVOKE ALL ON FUNCTION public._agreement_rate_timestamp() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.get_partner_agreement_rate(p_partner_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.partner_agreement_rate_requests%ROWTYPE; base numeric;
BEGIN
 IF NOT public._partner_return_policy_caller_ok(ARRAY['cfo','ceo','coo','manager','super_admin','partner_ops','financial_ops']) THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501'; END IF;
 base:=public.partner_rate_now(p_partner_id);
 SELECT * INTO r FROM public.partner_agreement_rate_requests WHERE partner_id=p_partner_id AND status<>'superseded' ORDER BY requested_at DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('request_id',r.id,'requested_rate',r.requested_rate,'rate_in_force',CASE WHEN r.status='approved' THEN r.requested_rate ELSE base END,'status',r.status,'awaits_cfo',coalesce(r.status='pending',false),'ready',r.id IS NULL OR r.status='approved','decision_note',r.decision_note);
END $$;
REVOKE ALL ON FUNCTION public.get_partner_agreement_rate(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_partner_agreement_rate(uuid) TO authenticated,service_role;

CREATE FUNCTION public.set_partner_agreement_rate(p_partner_id uuid,p_requested_rate numeric) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE base numeric; pol boolean; r public.partner_agreement_rate_requests%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT public._partner_return_policy_caller_ok(ARRAY['cfo','ceo','coo','manager','super_admin','partner_ops','financial_ops']) THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501'; END IF;
 PERFORM public.require_staff_aal2();
 IF p_requested_rate IS NULL OR p_requested_rate<=0 OR p_requested_rate>100 THEN RAISE EXCEPTION 'The Returns rate must be above 0 and at most 100'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('countersign-prepare-'||p_partner_id::text));
 IF EXISTS(SELECT 1 FROM public.investor_portfolios WHERE investor_id=p_partner_id) THEN RAISE EXCEPTION 'Use the existing portfolio rate editor'; END IF;
 base:=public.partner_rate_now(p_partner_id);
 SELECT enabled INTO pol FROM public.partner_return_policy WHERE id;
 IF NOT coalesce(pol,false) AND NOT public._has_enabled_role(auth.uid(),ARRAY['coo','manager']) THEN RAISE EXCEPTION 'Only the COO or a manager can change a Returns rate at the moment' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.partner_agreement_rate_requests WHERE partner_id=p_partner_id AND status IN ('pending','approved') AND applied_at IS NULL FOR UPDATE;
 IF r.requested_rate=p_requested_rate THEN RETURN public.get_partner_agreement_rate(p_partner_id); END IF;
 UPDATE public.partner_agreement_rate_requests SET status='superseded' WHERE partner_id=p_partner_id AND status IN ('pending','approved') AND applied_at IS NULL;
 INSERT INTO public.partner_agreement_rate_requests(partner_id,requested_rate,rate_in_force,status,requested_by,decided_by,decided_at,decision_note)
 VALUES(p_partner_id,p_requested_rate,base,CASE WHEN coalesce(pol,false) AND p_requested_rate<>base THEN 'pending' ELSE 'approved' END,auth.uid(),CASE WHEN NOT coalesce(pol,false) OR p_requested_rate=base THEN auth.uid() END,CASE WHEN NOT coalesce(pol,false) OR p_requested_rate=base THEN now() END,CASE WHEN NOT coalesce(pol,false) THEN 'Applied directly while Partner Returns was switched off' END);
 RETURN public.get_partner_agreement_rate(p_partner_id);
END $$;
REVOKE ALL ON FUNCTION public.set_partner_agreement_rate(uuid,numeric) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.set_partner_agreement_rate(uuid,numeric) TO authenticated;

CREATE FUNCTION public.list_agreement_rate_requests(p_status text DEFAULT 'pending',p_limit integer DEFAULT 200) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public._partner_return_policy_caller_ok(ARRAY['cfo','ceo','coo','super_admin','partner_ops']) THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(t.row),'[]'::jsonb) INTO result FROM (
 SELECT jsonb_build_object('request_id',r.id,'portfolio_id',r.portfolio_id,'portfolio_code',ip.portfolio_code,'partner_id',r.partner_id,'partner_name',p.full_name,'investment_amount',a.partnership_amount,'portfolio_status',ip.status,'source','agreement_rate','requested_rate',r.requested_rate,'rate_in_force',r.rate_in_force,'standard_rate',r.rate_in_force,'status',r.status,'requested_by',r.requested_by,'requested_by_name',req.full_name,'requested_at',r.requested_at,'decided_by',r.decided_by,'decided_at',r.decided_at,'decision_note',r.decision_note,'applied_at',r.applied_at,'current_rate',ip.roi_percentage,'stage',CASE WHEN r.status='approved' AND r.applied_at IS NULL THEN 'approved_next_cycle' WHEN r.status='approved' THEN 'applied' ELSE r.status END) row
 FROM public.partner_agreement_rate_requests r LEFT JOIN public.profiles p ON p.id=r.partner_id LEFT JOIN public.profiles req ON req.id=r.requested_by LEFT JOIN public.partner_agreements a ON a.partner_id=r.partner_id LEFT JOIN public.investor_portfolios ip ON ip.id=r.portfolio_id WHERE p_status IS NULL OR r.status=p_status ORDER BY r.requested_at DESC LIMIT least(greatest(coalesce(p_limit,200),1),1000)) t;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.list_agreement_rate_requests(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_agreement_rate_requests(text,integer) TO authenticated,service_role;

CREATE FUNCTION public.cfo_decide_agreement_rate_requests(p_request_ids uuid[],p_decision text,p_note text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer; s text;
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo']) THEN RAISE EXCEPTION 'Only the CFO can decide partner Returns rates' USING ERRCODE='42501'; END IF;
 PERFORM public.require_staff_aal2();
 s:=CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' END;
 IF s IS NULL OR cardinality(p_request_ids)>500 THEN RAISE EXCEPTION 'Invalid decision or batch'; END IF;
 IF s='rejected' AND nullif(trim(p_note),'') IS NULL THEN RAISE EXCEPTION 'A reason is required to reject'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('countersign-prepare-'||r.partner_id::text)) FROM public.partner_agreement_rate_requests r WHERE r.id=ANY(p_request_ids) ORDER BY r.partner_id;
 UPDATE public.partner_agreement_rate_requests SET status=s,decided_by=auth.uid(),decided_at=now(),decision_note=nullif(trim(p_note),'') WHERE id=ANY(p_request_ids) AND status='pending';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('decision',s,'decided',n,'skipped',coalesce(cardinality(p_request_ids),0)-n);
END $$;
REVOKE ALL ON FUNCTION public.cfo_decide_agreement_rate_requests(uuid[],text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.cfo_decide_agreement_rate_requests(uuid[],text,text) TO authenticated;

-- Modify the verified live definitions in place; fail if their insertion anchors drift.
DO $patch$
DECLARE d text; anchor text;
BEGIN
 d:=pg_get_functiondef('public.countersign_prepare_support(uuid,numeric,text,text,uuid,boolean)'::regprocedure);
 anchor:='  v_rate     numeric;';
 IF position(anchor IN d)=0 THEN RAISE EXCEPTION 'Countersign declaration drift'; END IF;
 d:=replace(d,anchor,anchor||E'\n  v_request public.partner_agreement_rate_requests%ROWTYPE;\n  v_contract_rate numeric;\n  v_expected text := nullif(current_setting(''app.agreement_expected_rate'',true),'''');');
 anchor:='  v_mode := coalesce(p_support_mode, a.support_mode);';
 IF position(anchor IN d)=0 THEN RAISE EXCEPTION 'Countersign flow drift'; END IF;
 d:=replace(d,anchor,$body$
  SELECT * INTO v_request FROM public.partner_agreement_rate_requests WHERE partner_id=p_partner_id AND status<>'superseded' ORDER BY requested_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF v_request.id IS NOT NULL AND v_request.status<>'approved' THEN
    RETURN jsonb_build_object('ok',false,'code','AGREEMENT_RATE_NOT_APPROVED','message','Wait for CFO approval of the agreement rate before countersigning.');
  END IF;
  v_contract_rate:=CASE WHEN v_request.status='approved' THEN v_request.requested_rate ELSE public.partner_rate_now(p_partner_id) END;
  IF v_expected IS NOT NULL AND v_expected::numeric IS DISTINCT FROM v_contract_rate THEN
    RETURN jsonb_build_object('ok',false,'code','AGREEMENT_RATE_CHANGED','message','The approved agreement rate changed. Review the contract and try again.');
  END IF;
$body$||anchor);
 anchor:='      roi_mode, duration_months, payout_day,';
 IF position(anchor IN d)=0 THEN RAISE EXCEPTION 'Countersign insert drift'; END IF;
 d:=replace(d,anchor,'      roi_mode, roi_percentage, duration_months, payout_day,');
 d:=replace(d,'      v_roi_mode, 12, least(','      v_roi_mode, v_contract_rate, 12, least(');
 anchor:='    INSERT INTO public.investor_portfolios (';
 d:=replace(d,anchor,$body$
    IF v_request.id IS NOT NULL AND v_request.applied_at IS NULL THEN
      UPDATE public.partner_agreement_rate_requests SET applied_xact=txid_current() WHERE id=v_request.id;
      PERFORM set_config('app.agreement_rate_request',v_request.id::text,true);
    END IF;
$body$||anchor);
 anchor:='    INSERT INTO public.wallet_transactions (sender_id, recipient_id, amount, description)';
 d:=replace(d,anchor,$body$
    IF v_rate IS DISTINCT FROM v_contract_rate THEN RAISE EXCEPTION 'The portfolio rate does not match the approved contract'; END IF;
    IF v_request.id IS NOT NULL AND v_request.applied_at IS NULL THEN
      UPDATE public.partner_agreement_rate_requests SET portfolio_id=v_pid,applied_at=now() WHERE id=v_request.id;
    END IF;
    PERFORM set_config('app.agreement_rate_request','',true);
$body$||anchor);
 EXECUTE d;
 d:=pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure);
 anchor:='  -- INSERT';
 IF position(anchor IN d)=0 THEN RAISE EXCEPTION 'Rate trigger drift'; END IF;
 d:=replace(d,anchor,$body$
  -- Only a locked, approved agreement request being consumed in this transaction can set a new portfolio rate.
  IF EXISTS(SELECT 1 FROM public.partner_agreement_rate_requests r WHERE r.id::text=current_setting('app.agreement_rate_request',true) AND r.partner_id=NEW.investor_id AND r.status='approved' AND r.applied_at IS NULL AND r.applied_xact=txid_current() AND r.requested_rate=NEW.roi_percentage) THEN
    NEW.entitled_rate:=NEW.roi_percentage;
    NEW.rate_decided_at:=clock_timestamp();
    NEW.rate_existing_at_decision:=NULL;
    NEW.rate_basis:=CASE WHEN v_on THEN 'cfo_approved' ELSE 'typed_switch_off' END;
    RETURN NEW;
  END IF;
$body$||anchor);
 EXECUTE d;
END $patch$;

CREATE FUNCTION public.countersign_prepare_support_with_rate(p_partner_id uuid,p_amount numeric,p_support_mode text,p_return_option text,p_actor uuid,p_expected_rate numeric,p_countersign_only boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF coalesce(auth.role(),'')<>'service_role' AND session_user<>'postgres' THEN RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501'; END IF;
 IF p_expected_rate IS NULL OR p_expected_rate<=0 OR p_expected_rate>100 THEN RAISE EXCEPTION 'Approved agreement rate is required'; END IF;
 PERFORM set_config('app.agreement_expected_rate',p_expected_rate::text,true);
 result:=public.countersign_prepare_support(p_partner_id,p_amount,p_support_mode,p_return_option,p_actor,p_countersign_only);
 PERFORM set_config('app.agreement_expected_rate','',true);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.countersign_prepare_support_with_rate(uuid,numeric,text,text,uuid,numeric,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.countersign_prepare_support_with_rate(uuid,numeric,text,text,uuid,numeric,boolean) TO service_role;
