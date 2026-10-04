
-- ============ CONFIG ============
CREATE TABLE IF NOT EXISTS public.service_center_qualification_config (
  id text PRIMARY KEY DEFAULT 'service_center_qualification_v1',
  rule_version text NOT NULL DEFAULT 'service_center_qualification_v1',
  required_sub_agents integer NOT NULL DEFAULT 20,
  required_main_agent_tenants integer NOT NULL DEFAULT 5,
  activity_window_days integer NOT NULL DEFAULT 30,
  allow_reapply_after_rejection boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.service_center_qualification_config TO authenticated;
GRANT ALL ON public.service_center_qualification_config TO service_role;
ALTER TABLE public.service_center_qualification_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "config readable by authenticated"
  ON public.service_center_qualification_config FOR SELECT TO authenticated USING (true);

INSERT INTO public.service_center_qualification_config (id) VALUES ('service_center_qualification_v1')
ON CONFLICT (id) DO NOTHING;

-- ============ REQUESTS ============
CREATE TABLE IF NOT EXISTS public.service_center_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected','cancelled','more_info_requested')),
  agent_name text NOT NULL,
  agent_phone text NOT NULL,
  agent_location text,
  district text,
  preferred_location text NOT NULL,
  reason text NOT NULL,
  ready_to_operate boolean NOT NULL DEFAULT false,
  supporting_note text,
  -- snapshot at submission
  qualifying_sub_agents_at_submission integer NOT NULL DEFAULT 0,
  personal_active_tenants_at_submission integer NOT NULL DEFAULT 0,
  network_active_tenants_at_submission integer NOT NULL DEFAULT 0,
  qualified_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  rule_version text NOT NULL DEFAULT 'service_center_qualification_v1',
  reviewed_by uuid,
  reviewed_at timestamptz,
  decision text,
  decision_reason text,
  internal_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_service_center_open_request
  ON public.service_center_requests(agent_id)
  WHERE status IN ('pending_review','more_info_requested');
CREATE INDEX IF NOT EXISTS idx_service_center_requests_agent ON public.service_center_requests(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_center_requests_status ON public.service_center_requests(status, created_at DESC);

GRANT SELECT, INSERT ON public.service_center_requests TO authenticated;
GRANT ALL ON public.service_center_requests TO service_role;
ALTER TABLE public.service_center_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agents view own service center requests"
  ON public.service_center_requests FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR public.is_ops_role(auth.uid()));
CREATE POLICY "agents create own service center requests"
  ON public.service_center_requests FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());
CREATE POLICY "ops update service center requests"
  ON public.service_center_requests FOR UPDATE TO authenticated
  USING (public.is_ops_role(auth.uid()))
  WITH CHECK (public.is_ops_role(auth.uid()));

-- ============ QUALIFICATION SNAPSHOT ============
CREATE TABLE IF NOT EXISTS public.service_center_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL UNIQUE,
  qualified_at timestamptz NOT NULL DEFAULT now(),
  qualifying_sub_agents_at_qualification integer NOT NULL,
  personal_active_tenants_at_qualification integer NOT NULL,
  network_active_tenants_at_qualification integer NOT NULL,
  rule_version text NOT NULL DEFAULT 'service_center_qualification_v1',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.service_center_qualifications TO authenticated;
GRANT ALL ON public.service_center_qualifications TO service_role;
ALTER TABLE public.service_center_qualifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agents view own qualification snapshot"
  ON public.service_center_qualifications FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR public.is_ops_role(auth.uid()));

-- ============ AUDIT ============
CREATE TABLE IF NOT EXISTS public.service_center_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.service_center_requests(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid,
  reason text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sc_request_events_request ON public.service_center_request_events(request_id, created_at DESC);
GRANT SELECT ON public.service_center_request_events TO authenticated;
GRANT ALL ON public.service_center_request_events TO service_role;
ALTER TABLE public.service_center_request_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops view service center request events"
  ON public.service_center_request_events FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()));

CREATE OR REPLACE FUNCTION public.touch_service_center_requests()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_touch_service_center_requests ON public.service_center_requests;
CREATE TRIGGER trg_touch_service_center_requests BEFORE UPDATE ON public.service_center_requests
FOR EACH ROW EXECUTE FUNCTION public.touch_service_center_requests();

CREATE OR REPLACE FUNCTION public.log_service_center_request_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.service_center_request_events(request_id, from_status, to_status, actor_id)
    VALUES (NEW.id, NULL, NEW.status, NEW.agent_id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.service_center_request_events(request_id, from_status, to_status, actor_id, reason, note)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.reviewed_by, NEW.decision_reason, NEW.internal_notes);
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_log_service_center_request_event ON public.service_center_requests;
CREATE TRIGGER trg_log_service_center_request_event AFTER INSERT OR UPDATE ON public.service_center_requests
FOR EACH ROW EXECUTE FUNCTION public.log_service_center_request_event();

-- ============ SUPPORTING INDEXES ============
CREATE INDEX IF NOT EXISTS idx_rent_requests_agent_status_tenancy ON public.rent_requests(agent_id, status, tenancy_status);
CREATE INDEX IF NOT EXISTS idx_rent_requests_assigned_agent_status ON public.rent_requests(assigned_agent_id, status, tenancy_status);
CREATE INDEX IF NOT EXISTS idx_agent_subagents_parent_status ON public.agent_subagents(parent_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_collections_agent_created ON public.agent_collections(agent_id, created_at DESC);

-- ============ QUALIFICATION SUMMARY ============
CREATE OR REPLACE FUNCTION public.get_service_center_qualification(p_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_cfg public.service_center_qualification_config%ROWTYPE;
  v_sub_count integer := 0;
  v_personal integer := 0;
  v_network integer := 0;
  v_req record;
  v_qual record;
  v_progress numeric;
  v_sub_met boolean;
  v_pers_met boolean;
  v_status text;
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'agent required';
  END IF;
  IF v_agent <> auth.uid() AND NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT * INTO v_cfg FROM public.service_center_qualification_config
   WHERE id = 'service_center_qualification_v1';

  -- personal active tenants (distinct tenants on live rent arrangements)
  SELECT count(DISTINCT rr.tenant_id) INTO v_personal
  FROM public.rent_requests rr
  JOIN public.profiles p ON p.id = rr.tenant_id
  WHERE (rr.agent_id = v_agent OR rr.assigned_agent_id = v_agent)
    AND rr.status IN ('funded','repaying')
    AND COALESCE(rr.tenancy_status,'active') = 'active'
    AND COALESCE(p.is_frozen,false) = false;

  -- qualifying sub-agents: verified link + at least one active tenant each
  WITH subs AS (
    SELECT DISTINCT s.sub_agent_id
    FROM public.agent_subagents s
    JOIN public.profiles sp ON sp.id = s.sub_agent_id
    WHERE s.parent_agent_id = v_agent
      AND s.status = 'verified'
      AND s.sub_agent_id <> v_agent
      AND COALESCE(sp.is_frozen,false) = false
  ), sub_tenants AS (
    SELECT s.sub_agent_id, count(DISTINCT rr.tenant_id) AS tenants
    FROM subs s
    JOIN public.rent_requests rr
      ON (rr.agent_id = s.sub_agent_id OR rr.assigned_agent_id = s.sub_agent_id)
    JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE rr.status IN ('funded','repaying')
      AND COALESCE(rr.tenancy_status,'active') = 'active'
      AND COALESCE(tp.is_frozen,false) = false
    GROUP BY s.sub_agent_id
  )
  SELECT count(*)::int, COALESCE(sum(tenants),0)::int
    INTO v_sub_count, v_network
  FROM sub_tenants WHERE tenants >= 1;

  v_network := v_network + v_personal;

  v_sub_met := v_sub_count >= v_cfg.required_sub_agents;
  v_pers_met := v_personal >= v_cfg.required_main_agent_tenants;
  v_progress := round(((
      LEAST(v_sub_count::numeric / NULLIF(v_cfg.required_sub_agents,0), 1)
    + LEAST(v_personal::numeric / NULLIF(v_cfg.required_main_agent_tenants,0), 1)
  ) / 2) * 100);

  SELECT * INTO v_qual FROM public.service_center_qualifications WHERE agent_id = v_agent;

  SELECT * INTO v_req FROM public.service_center_requests
   WHERE agent_id = v_agent ORDER BY created_at DESC LIMIT 1;

  IF v_req.id IS NOT NULL AND v_req.status IN ('pending_review','more_info_requested','approved','rejected') THEN
    v_status := CASE WHEN v_req.status = 'more_info_requested' THEN 'pending_review' ELSE v_req.status END;
  ELSIF v_sub_met AND v_pers_met THEN
    v_status := 'qualified';
  ELSE
    v_status := 'not_qualified';
  END IF;

  RETURN jsonb_build_object(
    'agent_id', v_agent,
    'rule_version', v_cfg.rule_version,
    'qualifying_sub_agents', v_sub_count,
    'required_sub_agents', v_cfg.required_sub_agents,
    'main_agent_active_tenants', v_personal,
    'required_main_agent_tenants', v_cfg.required_main_agent_tenants,
    'network_active_tenants', v_network,
    'sub_agent_requirement_met', v_sub_met,
    'personal_tenant_requirement_met', v_pers_met,
    'is_qualified', (v_sub_met AND v_pers_met),
    'qualification_progress', v_progress,
    'remaining_sub_agents', GREATEST(v_cfg.required_sub_agents - v_sub_count, 0),
    'remaining_personal_tenants', GREATEST(v_cfg.required_main_agent_tenants - v_personal, 0),
    'qualified_at', v_qual.qualified_at,
    'request_status', v_status,
    'request_id', v_req.id,
    'raw_request_status', v_req.status,
    'decision_reason', v_req.decision_reason,
    'activity_window_days', v_cfg.activity_window_days
  );
END; $$;
GRANT EXECUTE ON FUNCTION public.get_service_center_qualification(uuid) TO authenticated;

-- ============ SUBMIT REQUEST ============
CREATE OR REPLACE FUNCTION public.submit_service_center_request(
  p_agent_name text,
  p_agent_phone text,
  p_agent_location text,
  p_district text,
  p_preferred_location text,
  p_reason text,
  p_ready boolean,
  p_supporting_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_agent uuid := auth.uid();
  v_q jsonb;
  v_id uuid;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF COALESCE(p_ready,false) = false THEN
    RAISE EXCEPTION 'You must confirm you are ready to operate the service center';
  END IF;
  IF coalesce(trim(p_preferred_location),'') = '' OR coalesce(trim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'Preferred location and reason are required';
  END IF;

  v_q := public.get_service_center_qualification(v_agent);
  IF NOT (v_q->>'is_qualified')::boolean THEN
    RAISE EXCEPTION 'You have not met the qualification requirements';
  END IF;

  IF EXISTS (SELECT 1 FROM public.service_center_requests
              WHERE agent_id = v_agent AND status IN ('pending_review','more_info_requested','approved')) THEN
    RAISE EXCEPTION 'You already have an active service center request';
  END IF;

  INSERT INTO public.service_center_qualifications(
    agent_id, qualifying_sub_agents_at_qualification,
    personal_active_tenants_at_qualification, network_active_tenants_at_qualification)
  VALUES (v_agent, (v_q->>'qualifying_sub_agents')::int,
          (v_q->>'main_agent_active_tenants')::int, (v_q->>'network_active_tenants')::int)
  ON CONFLICT (agent_id) DO NOTHING;

  INSERT INTO public.service_center_requests(
    agent_id, agent_name, agent_phone, agent_location, district,
    preferred_location, reason, ready_to_operate, supporting_note,
    qualifying_sub_agents_at_submission, personal_active_tenants_at_submission,
    network_active_tenants_at_submission, qualified_at)
  VALUES (
    v_agent, p_agent_name, p_agent_phone, p_agent_location, p_district,
    trim(p_preferred_location), trim(p_reason), true, p_supporting_note,
    (v_q->>'qualifying_sub_agents')::int, (v_q->>'main_agent_active_tenants')::int,
    (v_q->>'network_active_tenants')::int,
    (SELECT qualified_at FROM public.service_center_qualifications WHERE agent_id = v_agent))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status','pending_review','request_id', v_id);
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_service_center_request(text,text,text,text,text,text,boolean,text) TO authenticated;

-- ============ ADMIN LIST + DECISION ============
CREATE OR REPLACE FUNCTION public.admin_list_service_center_requests(
  p_status text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows jsonb; v_total integer;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  SELECT count(*) INTO v_total FROM public.service_center_requests r
   WHERE p_status IS NULL OR r.status = p_status;
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_rows FROM (
    SELECT to_jsonb(r) || jsonb_build_object(
      'profile_phone', p.phone,
      'profile_district', p.district,
      'profile_is_frozen', COALESCE(p.is_frozen,false),
      'current_metrics', public.get_service_center_qualification(r.agent_id),
      'existing_service_centres', (SELECT count(*) FROM public.service_centre_setups s WHERE s.agent_id = r.agent_id)
    ) AS x
    FROM public.service_center_requests r
    LEFT JOIN public.profiles p ON p.id = r.agent_id
    WHERE p_status IS NULL OR r.status = p_status
    ORDER BY r.created_at DESC
    LIMIT LEAST(COALESCE(p_limit,50),200) OFFSET COALESCE(p_offset,0)
  ) t;
  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_list_service_center_requests(text,integer,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_decide_service_center_request(
  p_request_id uuid, p_decision text, p_reason text DEFAULT NULL, p_internal_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN RAISE EXCEPTION 'not authorized'; END IF;
  v_status := CASE p_decision
    WHEN 'approve' THEN 'approved'
    WHEN 'reject' THEN 'rejected'
    WHEN 'more_info' THEN 'more_info_requested'
    WHEN 'note' THEN NULL
    ELSE NULL END;
  IF p_decision = 'reject' AND coalesce(trim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'A rejection reason is required';
  END IF;

  IF p_decision = 'note' THEN
    UPDATE public.service_center_requests
       SET internal_notes = COALESCE(internal_notes || E'\n', '') || COALESCE(p_internal_note,'')
     WHERE id = p_request_id;
  ELSE
    IF v_status IS NULL THEN RAISE EXCEPTION 'invalid decision'; END IF;
    UPDATE public.service_center_requests
       SET status = v_status, decision = p_decision, decision_reason = p_reason,
           internal_notes = CASE WHEN p_internal_note IS NULL THEN internal_notes
                                 ELSE COALESCE(internal_notes || E'\n','') || p_internal_note END,
           reviewed_by = auth.uid(), reviewed_at = now()
     WHERE id = p_request_id;
  END IF;
  RETURN jsonb_build_object('status', COALESCE(v_status,'noted'));
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_decide_service_center_request(uuid,text,text,text) TO authenticated;
