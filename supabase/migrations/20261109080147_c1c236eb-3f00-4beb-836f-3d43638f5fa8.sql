CREATE SCHEMA signage_internal;
REVOKE ALL ON SCHEMA signage_internal FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA signage_internal TO authenticated,service_role;
ALTER FUNCTION public.cfo_disburse_signage(uuid,text,integer) SET SCHEMA signage_internal;
REVOKE ALL ON FUNCTION signage_internal.cfo_disburse_signage(uuid,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION signage_internal.cfo_disburse_signage(uuid,text,integer) TO authenticated,service_role;
CREATE FUNCTION public.cfo_disburse_signage(p_signage_id uuid,p_payout_type text,p_period_index integer) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$ SELECT signage_internal.cfo_disburse_signage(p_signage_id,p_payout_type,p_period_index) $$;
REVOKE ALL ON FUNCTION public.cfo_disburse_signage(uuid,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cfo_disburse_signage(uuid,text,integer) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public._welile_signages_coo_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_agent_ops boolean := public._has_enabled_role(auth.uid(), ARRAY['agent_ops','operations','manager','super_admin','admin','ceo']); v_coo boolean := public._has_enabled_role(auth.uid(), ARRAY['coo','super_admin']);
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF new.status <> 'submitted' THEN RAISE EXCEPTION 'New signage applications must be submitted for review'; END IF;
  new.coo_approved_by := NULL; new.coo_approved_at := NULL; new.coo_review_notes := NULL;
  RETURN new;
 END IF;
 new.coo_approved_by := old.coo_approved_by; new.coo_approved_at := old.coo_approved_at;
 IF new.status IS NOT DISTINCT FROM old.status THEN
  IF new.coo_review_notes IS DISTINCT FROM old.coo_review_notes THEN RAISE EXCEPTION 'COO notes can only change with a COO decision'; END IF;
  RETURN new;
 END IF;
 IF old.status IN ('submitted','pending','under_review','changes_required') AND new.status IN ('awaiting_coo','approved_for_installation','changes_required','rejected') THEN
  IF NOT v_agent_ops THEN RAISE EXCEPTION 'Only Agent Ops can review pending signage applications'; END IF;
  IF new.status IN ('awaiting_coo','approved_for_installation') THEN new.status := 'awaiting_coo'; END IF;
  new.reviewed_by := auth.uid(); new.reviewed_at := now();
 ELSIF old.status = 'awaiting_coo' THEN
  IF NOT v_coo OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the COO can decide applications awaiting COO approval'; END IF;
  IF new.status NOT IN ('approved_for_installation','changes_required','rejected') THEN RAISE EXCEPTION 'A COO approval decision is required before installation'; END IF;
  IF new.status = 'approved_for_installation' THEN new.coo_approved_by := auth.uid(); new.coo_approved_at := now(); END IF;
 ELSIF new.status IN ('awaiting_coo','approved_for_installation') THEN
  RAISE EXCEPTION 'This application is not at the required approval stage';
 END IF;
 IF new.coo_review_notes IS DISTINCT FROM old.coo_review_notes AND old.status <> 'awaiting_coo' THEN RAISE EXCEPTION 'Only a COO decision may change COO notes'; END IF;
 IF new.status IN ('pending_installation','installation_verification','awaiting_cfo','active') AND old.status NOT IN ('approved_for_installation','pending_installation','installation_verification','awaiting_cfo','active','temporarily_inactive','payment_on_hold') THEN
  RAISE EXCEPTION 'COO approval is required before installation';
 END IF;
 RETURN new;
END $$;