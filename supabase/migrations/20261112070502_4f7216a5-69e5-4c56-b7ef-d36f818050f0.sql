CREATE OR REPLACE FUNCTION signage_internal.cfo_approve_signage(p_signage_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE s public.welile_signages; old_flag text:=coalesce(current_setting('welile.signage_cfo_approval',true),''); old_payout text:=coalesce(current_setting('welile.signage_payout',true),'');
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(),ARRAY['cfo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the CFO can approve signage' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.welile_signages WHERE id=p_signage_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;
 IF s.status='active' THEN RETURN jsonb_build_object('signage_id',s.id,'status',s.status,'already_approved',true); END IF;
 IF s.status<>'awaiting_cfo' OR s.coo_approved_at IS NULL THEN RAISE EXCEPTION 'This application is not awaiting CFO approval'; END IF;
 PERFORM set_config('welile.signage_cfo_approval','on',true); PERFORM set_config('welile.signage_payout','on',true);
 UPDATE public.welile_signages SET status='active' WHERE id=p_signage_id RETURNING * INTO s;
 PERFORM set_config('welile.signage_cfo_approval',old_flag,true); PERFORM set_config('welile.signage_payout',old_payout,true);
 PERFORM public.recompute_trust_score(s.agent_id);
 RETURN jsonb_build_object('signage_id',s.id,'status',s.status,'already_approved',false);
END $function$;
REVOKE ALL ON FUNCTION signage_internal.cfo_approve_signage(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION signage_internal.cfo_approve_signage(uuid) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.cfo_approve_signage(p_signage_id uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public AS $function$ SELECT signage_internal.cfo_approve_signage(p_signage_id) $function$;
REVOKE ALL ON FUNCTION public.cfo_approve_signage(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cfo_approve_signage(uuid) TO authenticated,service_role;