DO $patch$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.countersign_prepare_support(uuid,numeric,text,text,uuid,boolean)'::regprocedure);
 d:=replace(d,'v_roi_mode, v_contract_rate, 12, least(','v_roi_mode, CASE WHEN v_request.id IS NOT NULL THEN v_contract_rate ELSE NULL END, 12, least(');
 d:=replace(d,'IF v_rate IS DISTINCT FROM v_contract_rate THEN','IF v_request.id IS NOT NULL AND v_rate IS DISTINCT FROM v_contract_rate THEN');
 EXECUTE d;
END $patch$;
COMMENT ON FUNCTION public.get_partner_agreement_rate(uuid) IS 'Intentional authenticated SECURITY DEFINER API: enabled staff-role and MFA read gate; no public partner data.';
COMMENT ON FUNCTION public.set_partner_agreement_rate(uuid,numeric) IS 'Intentional authenticated SECURITY DEFINER API: authenticated enabled staff roles, staff MFA and existing rate-policy restrictions; no direct table writes granted.';
COMMENT ON FUNCTION public.list_agreement_rate_requests(text,integer) IS 'Intentional authenticated SECURITY DEFINER API: same enabled staff-role and MFA gate as the existing CFO rate queue.';
COMMENT ON FUNCTION public.cfo_decide_agreement_rate_requests(uuid[],text,text) IS 'Intentional authenticated SECURITY DEFINER API: real enabled CFO role and require_staff_aal2, locked decisions only; no money movement.';