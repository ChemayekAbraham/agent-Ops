ALTER TABLE public.welile_signages ADD COLUMN coo_approved_by uuid, ADD COLUMN coo_approved_at timestamptz, ADD COLUMN coo_review_notes text;
ALTER TABLE public.welile_signages DROP CONSTRAINT welile_signages_status_check;
ALTER TABLE public.welile_signages ADD CONSTRAINT welile_signages_status_check CHECK (status = ANY (ARRAY['draft','submitted','pending','under_review','changes_required','awaiting_coo','rejected','approved_for_installation','pending_installation','installation_verification','active','temporarily_inactive','payment_on_hold','removal_requested','removed','cancelled']::text[]));
CREATE OR REPLACE FUNCTION public._welile_signages_coo_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
 IF new.status IN ('pending_installation','installation_verification','active') AND old.status NOT IN ('approved_for_installation','pending_installation','installation_verification','active','temporarily_inactive','payment_on_hold') THEN
  RAISE EXCEPTION 'COO approval is required before installation';
 END IF;
 RETURN new;
END; $$;
REVOKE ALL ON FUNCTION public._welile_signages_coo_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_signages_coo_workflow BEFORE INSERT OR UPDATE ON public.welile_signages FOR EACH ROW EXECUTE FUNCTION public._welile_signages_coo_guard();
CREATE OR REPLACE FUNCTION public.coo_decide_signage(p_signage_id uuid, p_decision text, p_notes text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.welile_signages; v_status text;
BEGIN
 IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(), ARRAY['coo','super_admin']) OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Only the COO can decide signage applications'; END IF;
 IF p_decision NOT IN ('approve','return','reject') OR p_decision IS NULL THEN RAISE EXCEPTION 'Invalid signage decision'; END IF;
 IF p_decision IN ('return','reject') AND length(trim(coalesce(p_notes,''))) < 10 THEN RAISE EXCEPTION 'Please enter a reason of at least 10 characters'; END IF;
 SELECT * INTO v_row FROM public.welile_signages WHERE id = p_signage_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Signage application not found'; END IF;
 IF v_row.status <> 'awaiting_coo' THEN RAISE EXCEPTION 'This application is no longer awaiting COO approval. Refresh the queue.'; END IF;
 v_status := CASE p_decision WHEN 'approve' THEN 'approved_for_installation' WHEN 'return' THEN 'changes_required' ELSE 'rejected' END;
 UPDATE public.welile_signages SET status=v_status, coo_review_notes=nullif(trim(p_notes),''), review_notes=coalesce(nullif(trim(p_notes),''),review_notes), rejection_reason=CASE WHEN p_decision='reject' THEN trim(p_notes) ELSE NULL END WHERE id=p_signage_id RETURNING * INTO v_row;
 RETURN jsonb_build_object('id',v_row.id,'status',v_row.status);
END; $$;
REVOKE ALL ON FUNCTION public.coo_decide_signage(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coo_decide_signage(uuid,text,text) TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public._welile_signages_workflow_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF new.status IS DISTINCT FROM old.status THEN
  INSERT INTO public.system_events(event_type,user_id,related_entity_type,related_entity_id,metadata,actor_id) VALUES ('welile_signage_status_changed',new.agent_id,'welile_signages',new.id,jsonb_build_object('from_status',old.status,'to_status',new.status,'coo_approved_at',new.coo_approved_at),auth.uid());
  INSERT INTO public.audit_logs(user_id,action_type,table_name,record_id,reason,old_values,new_values,performed_by) VALUES (auth.uid(),'signage_status_changed','welile_signages',new.id,coalesce(nullif(new.coo_review_notes,''),nullif(new.review_notes,''),'Signage workflow decision recorded'),jsonb_build_object('status',old.status),jsonb_build_object('status',new.status),auth.uid());
 END IF;
 RETURN new;
END; $$;
REVOKE ALL ON FUNCTION public._welile_signages_workflow_event() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_signages_workflow_event AFTER UPDATE ON public.welile_signages FOR EACH ROW EXECUTE FUNCTION public._welile_signages_workflow_event();