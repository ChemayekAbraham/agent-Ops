CREATE TABLE public.staff_requisition_usage_report_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('shown','deferred','acknowledged','submitted')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX srure_req_idx ON public.staff_requisition_usage_report_events (requisition_id, created_at);
GRANT SELECT ON public.staff_requisition_usage_report_events TO authenticated;
GRANT ALL ON public.staff_requisition_usage_report_events TO service_role;
ALTER TABLE public.staff_requisition_usage_report_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "requester reads own usage report events" ON public.staff_requisition_usage_report_events
  FOR SELECT TO authenticated USING (requester_id = auth.uid() OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin'));

CREATE OR REPLACE FUNCTION public._usage_report_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Usage report events are append-only'; END $$;
CREATE TRIGGER trg_usage_report_events_append_only BEFORE UPDATE OR DELETE ON public.staff_requisition_usage_report_events
  FOR EACH ROW EXECUTE FUNCTION public._usage_report_events_append_only();

CREATE OR REPLACE FUNCTION public.get_my_usage_report_notices()
RETURNS TABLE (requisition_id uuid, requisition_code text, title text, amount numeric, approved_amount numeric,
  reason text, category text, cfo_decided_at timestamptz, grace_ends_at timestamptz, deferral_count integer,
  max_deferrals integer, mandatory boolean, acknowledged boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.requisition_code, r.title, r.amount, r.approved_amount, r.reason, r.category::text,
    r.cfo_decided_at, r.cfo_decided_at + interval '36 hours',
    d.n, 2, d.n >= 2,
    EXISTS (SELECT 1 FROM public.staff_requisition_usage_report_events e WHERE e.requisition_id = r.id AND e.event = 'acknowledged')
  FROM public.staff_requisitions r
  CROSS JOIN LATERAL (SELECT count(*)::int n FROM public.staff_requisition_usage_report_deferrals x WHERE x.requisition_id = r.id) d
  WHERE auth.uid() IS NOT NULL AND r.requester_id = auth.uid() AND r.stage = 'approved'
    AND r.cfo_decided_at IS NOT NULL AND r.cfo_decided_at + interval '36 hours' <= now()
    AND (r.request_kind IS NULL OR r.request_kind <> 'facilitation')
    AND NOT EXISTS (SELECT 1 FROM public.staff_requisition_usage_reports u WHERE u.requisition_id = r.id)
  ORDER BY r.cfo_decided_at ASC LIMIT 50
$$;
REVOKE ALL ON FUNCTION public.get_my_usage_report_notices() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_usage_report_notices() TO authenticated;

CREATE OR REPLACE FUNCTION public.log_usage_report_notice_event(p_requisition_id uuid, p_event text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_req record; v_n int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501'; END IF;
  IF p_event NOT IN ('shown','acknowledged') THEN RAISE EXCEPTION 'Unsupported event' USING ERRCODE = '22023'; END IF;
  SELECT id, requester_id, stage, cfo_decided_at INTO v_req FROM public.staff_requisitions WHERE id = p_requisition_id;
  IF NOT FOUND OR v_req.requester_id <> v_uid THEN RAISE EXCEPTION 'Only the requester can record this' USING ERRCODE = '42501'; END IF;
  IF v_req.stage <> 'approved' OR v_req.cfo_decided_at IS NULL OR v_req.cfo_decided_at + interval '36 hours' > now() THEN
    RAISE EXCEPTION 'This accountability notice is not due yet' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_n FROM public.staff_requisition_usage_report_deferrals WHERE requisition_id = p_requisition_id;
  IF p_event = 'shown' THEN
    -- the popup re-opens every few minutes; keep one "shown" row per notice round per hour
    IF EXISTS (SELECT 1 FROM public.staff_requisition_usage_report_events WHERE requisition_id = p_requisition_id
               AND event = 'shown' AND created_at > now() - interval '1 hour' AND (detail->>'notice_no')::int = v_n + 1) THEN
      RETURN jsonb_build_object('logged', false);
    END IF;
  ELSE
    IF v_n < 2 THEN RAISE EXCEPTION 'Acknowledgement is only needed on the final notice' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.staff_requisition_usage_report_events WHERE requisition_id = p_requisition_id AND event = 'acknowledged') THEN
      RETURN jsonb_build_object('logged', false);
    END IF;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_uid, 'requisition_usage_report_acknowledged', 'staff_requisitions', p_requisition_id::text,
      'Requester acknowledged mandatory accountability notice', jsonb_build_object('deferrals', v_n));
  END IF;
  INSERT INTO public.staff_requisition_usage_report_events (requisition_id, requester_id, event, detail)
  VALUES (p_requisition_id, v_uid, p_event, jsonb_build_object('notice_no', v_n + 1, 'deferrals', v_n));
  RETURN jsonb_build_object('logged', true);
END $$;
REVOKE ALL ON FUNCTION public.log_usage_report_notice_event(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_usage_report_notice_event(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.defer_requisition_usage_report(p_requisition_id uuid, p_reason text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_req record; v_count integer; v_id uuid;
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
  IF v_req.cfo_decided_at + interval '36 hours' > now() THEN
    RAISE EXCEPTION 'This accountability notice is not due yet' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.staff_requisition_usage_reports WHERE requisition_id = p_requisition_id) THEN
    RAISE EXCEPTION 'A usage report has already been submitted' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.staff_requisition_usage_report_deferrals
   WHERE requisition_id = p_requisition_id;
  IF v_count >= 2 THEN
    RAISE EXCEPTION 'Maximum deferrals reached. This accountability report can no longer be deferred.'
      USING ERRCODE = 'P0001', HINT = 'max_deferrals_reached';
  END IF;
  INSERT INTO public.staff_requisition_usage_report_deferrals (requisition_id, requester_id, deferral_no, reason)
  VALUES (p_requisition_id, v_uid, v_count + 1, btrim(p_reason)) RETURNING id INTO v_id;
  INSERT INTO public.staff_requisition_usage_report_events (requisition_id, requester_id, event, detail)
  VALUES (p_requisition_id, v_uid, 'deferred', jsonb_build_object('deferral_no', v_count + 1, 'reason', btrim(p_reason)));
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'requisition_usage_report_deferred', 'staff_requisitions', p_requisition_id::text,
          btrim(p_reason), jsonb_build_object('deferral_id', v_id, 'deferral_no', v_count + 1, 'max', 2));
  RETURN jsonb_build_object('deferral_no', v_count + 1, 'remaining', 2 - (v_count + 1));
END $function$;

CREATE OR REPLACE FUNCTION public._usage_report_log_submitted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.staff_requisition_usage_report_events (requisition_id, requester_id, event, detail)
  VALUES (NEW.requisition_id, NEW.requester_id, 'submitted', jsonb_build_object('report_id', NEW.id, 'amount_used', NEW.amount_used));
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (NEW.requester_id, 'requisition_usage_report_submitted', 'staff_requisitions', NEW.requisition_id::text,
    'Requester submitted accountability usage report', jsonb_build_object('report_id', NEW.id));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_usage_report_log_submitted AFTER INSERT ON public.staff_requisition_usage_reports
  FOR EACH ROW EXECUTE FUNCTION public._usage_report_log_submitted();