CREATE TABLE public.staff_requisition_usage_report_deferrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES public.staff_requisitions(id),
  requester_id uuid NOT NULL,
  deferral_no integer NOT NULL CHECK (deferral_no BETWEEN 1 AND 5),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requisition_id, deferral_no)
);
GRANT SELECT ON public.staff_requisition_usage_report_deferrals TO authenticated;
GRANT ALL ON public.staff_requisition_usage_report_deferrals TO service_role;
ALTER TABLE public.staff_requisition_usage_report_deferrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Requester reads own deferrals" ON public.staff_requisition_usage_report_deferrals
  FOR SELECT TO authenticated USING (requester_id = auth.uid());
CREATE POLICY "Finance leadership reads deferrals" ON public.staff_requisition_usage_report_deferrals
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'super_admin'));

CREATE OR REPLACE FUNCTION public.staff_requisition_usage_report_deferrals_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Deferral records are append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER trg_usage_report_deferrals_append_only
  BEFORE UPDATE OR DELETE ON public.staff_requisition_usage_report_deferrals
  FOR EACH ROW EXECUTE FUNCTION public.staff_requisition_usage_report_deferrals_append_only();

CREATE OR REPLACE FUNCTION public.defer_requisition_usage_report(p_requisition_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req record;
  v_count integer;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters for deferring' USING ERRCODE = '22023';
  END IF;
  SELECT id, requester_id, stage, cfo_decided_at INTO v_req
    FROM public.staff_requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND OR v_req.requester_id <> v_uid THEN
    RAISE EXCEPTION 'Only the requester can defer this accountability report' USING ERRCODE = '42501';
  END IF;
  IF v_req.stage <> 'approved' OR v_req.cfo_decided_at IS NULL THEN
    RAISE EXCEPTION 'This requisition is not awaiting an accountability report' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.staff_requisition_usage_reports WHERE requisition_id = p_requisition_id) THEN
    RAISE EXCEPTION 'A usage report has already been submitted' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.staff_requisition_usage_report_deferrals
   WHERE requisition_id = p_requisition_id;
  IF v_count >= 5 THEN
    RAISE EXCEPTION 'Maximum deferrals reached. This accountability report can no longer be deferred.'
      USING ERRCODE = 'P0001', HINT = 'max_deferrals_reached';
  END IF;
  INSERT INTO public.staff_requisition_usage_report_deferrals (requisition_id, requester_id, deferral_no, reason)
  VALUES (p_requisition_id, v_uid, v_count + 1, btrim(p_reason)) RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'requisition_usage_report_deferred', 'staff_requisitions', p_requisition_id::text,
          btrim(p_reason), jsonb_build_object('deferral_id', v_id, 'deferral_no', v_count + 1, 'max', 5));
  RETURN jsonb_build_object('deferral_no', v_count + 1, 'remaining', 5 - (v_count + 1));
END $$;
REVOKE ALL ON FUNCTION public.defer_requisition_usage_report(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.defer_requisition_usage_report(uuid, text) TO authenticated;