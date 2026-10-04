-- 1. Service center manager register -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.service_center_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  source text NOT NULL DEFAULT 'auto_qualification',
  qualifying_sub_agents integer NOT NULL DEFAULT 0,
  personal_active_tenants integer NOT NULL DEFAULT 0,
  rule_version text,
  tagged_at timestamptz NOT NULL DEFAULT now(),
  tagged_by uuid,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_center_managers_status_check CHECK (status IN ('active','revoked'))
);

GRANT SELECT ON public.service_center_managers TO authenticated;
GRANT ALL ON public.service_center_managers TO service_role;
ALTER TABLE public.service_center_managers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scm_self_select" ON public.service_center_managers;
CREATE POLICY "scm_self_select" ON public.service_center_managers
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid() OR public.is_ops_role(auth.uid()));

CREATE OR REPLACE FUNCTION public.touch_service_center_managers()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_service_center_managers ON public.service_center_managers;
CREATE TRIGGER trg_touch_service_center_managers
  BEFORE UPDATE ON public.service_center_managers
  FOR EACH ROW EXECUTE FUNCTION public.touch_service_center_managers();

CREATE INDEX IF NOT EXISTS idx_scm_active ON public.service_center_managers(agent_id) WHERE status = 'active';

-- 2. Rent request columns + status ----------------------------------------------------
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS service_center_manager_id uuid,
  ADD COLUMN IF NOT EXISTS service_center_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS service_center_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_center_comment text;

CREATE INDEX IF NOT EXISTS idx_rent_requests_sc_manager
  ON public.rent_requests(service_center_manager_id, status);

ALTER TABLE public.rent_requests DROP CONSTRAINT IF EXISTS rent_requests_status_check;
ALTER TABLE public.rent_requests ADD CONSTRAINT rent_requests_status_check
CHECK (status = ANY (ARRAY[
  'pending'::text,
  'service_center_review'::text,
  'approved'::text,
  'rejected'::text,
  'cancelled'::text,
  'deleted_by_agent'::text,
  'agent_ops_approved'::text,
  'tenant_ops_approved'::text,
  'agent_verified'::text,
  'landlord_ops_approved'::text,
  'coo_approved'::text,
  'funded'::text,
  'disbursed'::text,
  'repaying'::text,
  'fully_repaid'::text,
  'defaulted'::text,
  'completed'::text
]));

-- 3. Helpers --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_service_center_manager(p_agent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.service_center_managers
    WHERE agent_id = p_agent_id AND status = 'active'
  );
$$;

-- Returns the service center manager that must vet a request submitted by p_agent_id,
-- or NULL when the request should go straight into the ops pipeline.
CREATE OR REPLACE FUNCTION public.resolve_service_center_manager_for_agent(p_agent_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_parent uuid;
BEGIN
  IF p_agent_id IS NULL THEN RETURN NULL; END IF;
  -- a service center manager never vets their own submissions
  IF public.is_service_center_manager(p_agent_id) THEN RETURN NULL; END IF;

  SELECT s.parent_agent_id INTO v_parent
  FROM public.agent_subagents s
  WHERE s.sub_agent_id = p_agent_id
    AND s.status = 'verified'
    AND s.parent_agent_id <> p_agent_id
    AND public.is_service_center_manager(s.parent_agent_id)
  ORDER BY s.verified_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1;

  RETURN v_parent;
END; $$;

-- 4. Routing trigger ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_rent_request_service_center()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_manager uuid;
BEGIN
  IF COALESCE(NEW.status,'pending') <> 'pending' THEN RETURN NEW; END IF;

  v_manager := public.resolve_service_center_manager_for_agent(COALESCE(NEW.agent_id, NEW.assigned_agent_id));

  IF v_manager IS NOT NULL THEN
    NEW.status := 'service_center_review';
    NEW.service_center_manager_id := v_manager;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_route_rent_request_service_center ON public.rent_requests;
CREATE TRIGGER trg_route_rent_request_service_center
  BEFORE INSERT ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.route_rent_request_service_center();

-- 5. Review RPC -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_center_review_rent_request(
  p_request_id uuid,
  p_decision text,
  p_comment text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.rent_requests%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_ops boolean := public.is_ops_role(auth.uid());
  v_new_status text;
BEGIN
  IF p_decision NOT IN ('verify','reject') THEN
    RAISE EXCEPTION 'invalid decision';
  END IF;

  SELECT * INTO v_req FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'request not found'; END IF;

  IF v_req.status <> 'service_center_review' THEN
    RAISE EXCEPTION 'request is not awaiting service center review';
  END IF;

  IF NOT v_is_ops AND v_req.service_center_manager_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'not authorized to review this request';
  END IF;

  IF p_decision = 'reject' AND COALESCE(btrim(p_comment),'') = '' THEN
    RAISE EXCEPTION 'a reason is required when declining';
  END IF;

  v_new_status := CASE WHEN p_decision = 'verify' THEN 'pending' ELSE 'rejected' END;

  UPDATE public.rent_requests
     SET status = v_new_status,
         service_center_reviewed_by = v_actor,
         service_center_reviewed_at = now(),
         service_center_comment = p_comment,
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    CASE WHEN p_decision = 'verify'
      THEN 'rent_request.service_center_verified'
      ELSE 'rent_request.service_center_rejected' END,
    v_actor,
    'rent_request',
    p_request_id,
    jsonb_build_object(
      'service_center_manager_id', v_req.service_center_manager_id,
      'submitting_agent_id', v_req.agent_id,
      'tenant_id', v_req.tenant_id,
      'previous_status', v_req.status,
      'new_status', v_new_status,
      'comment', p_comment,
      'reviewed_by_ops', v_is_ops
    )
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id, 'status', v_new_status);
END; $$;

GRANT EXECUTE ON FUNCTION public.service_center_review_rent_request(uuid, text, text) TO authenticated;

-- 6. Queue RPC ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_service_center_rent_queue(p_manager_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_manager uuid := COALESCE(p_manager_id, auth.uid());
  v_rows jsonb;
  v_reviewed jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'manager required'; END IF;
  IF v_manager <> auth.uid() AND NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at'), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'created_at', rr.created_at,
      'rent_amount', rr.rent_amount,
      'duration_days', rr.duration_days,
      'daily_repayment', rr.daily_repayment,
      'total_repayment', rr.total_repayment,
      'house_category', rr.house_category,
      'request_city', rr.request_city,
      'house_image_urls', rr.house_image_urls,
      'tenant_photo_url', rr.tenant_photo_url,
      'tenant_id', rr.tenant_id,
      'tenant_name', tp.full_name,
      'tenant_phone', tp.phone,
      'agent_id', rr.agent_id,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'agent_avatar_url', ap.avatar_url,
      'landlord_name', lp.full_name,
      'landlord_phone', lp.phone
    ) AS x
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.status = 'service_center_review'
  ) s;

  SELECT COALESCE(jsonb_agg(y ORDER BY y->>'service_center_reviewed_at' DESC), '[]'::jsonb) INTO v_reviewed
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'rent_amount', rr.rent_amount,
      'tenant_name', tp.full_name,
      'agent_name', ap.full_name,
      'service_center_reviewed_at', rr.service_center_reviewed_at,
      'service_center_comment', rr.service_center_comment
    ) AS y
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.service_center_reviewed_at IS NOT NULL
    ORDER BY rr.service_center_reviewed_at DESC
    LIMIT 25
  ) r;

  RETURN jsonb_build_object(
    'manager_id', v_manager,
    'is_service_center_manager', public.is_service_center_manager(v_manager),
    'pending_count', jsonb_array_length(v_rows),
    'pending', v_rows,
    'recent_reviewed', v_reviewed
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.get_service_center_rent_queue(uuid) TO authenticated;

-- 7. Auto-tagging ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_service_center_manager_tags()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg public.service_center_qualification_config%ROWTYPE;
  v_tagged integer := 0;
BEGIN
  SELECT * INTO v_cfg FROM public.service_center_qualification_config
   WHERE id = 'service_center_qualification_v1';

  WITH personal AS (
    SELECT rr.agent_id AS agent_id, count(DISTINCT rr.tenant_id) AS tenants
    FROM public.rent_requests rr
    JOIN public.profiles p ON p.id = rr.tenant_id
    WHERE rr.status IN ('funded','repaying')
      AND COALESCE(rr.tenancy_status,'active') = 'active'
      AND COALESCE(p.is_frozen,false) = false
      AND rr.agent_id IS NOT NULL
    GROUP BY rr.agent_id
  ), sub_links AS (
    SELECT DISTINCT s.parent_agent_id, s.sub_agent_id
    FROM public.agent_subagents s
    JOIN public.profiles sp ON sp.id = s.sub_agent_id
    WHERE s.status = 'verified'
      AND s.sub_agent_id <> s.parent_agent_id
      AND COALESCE(sp.is_frozen,false) = false
  ), sub_tenants AS (
    SELECT sl.parent_agent_id, sl.sub_agent_id, count(DISTINCT rr.tenant_id) AS tenants
    FROM sub_links sl
    JOIN public.rent_requests rr
      ON (rr.agent_id = sl.sub_agent_id OR rr.assigned_agent_id = sl.sub_agent_id)
    JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE rr.status IN ('funded','repaying')
      AND COALESCE(rr.tenancy_status,'active') = 'active'
      AND COALESCE(tp.is_frozen,false) = false
    GROUP BY sl.parent_agent_id, sl.sub_agent_id
  ), qualifying AS (
    SELECT parent_agent_id AS agent_id, count(*)::int AS qualifying_subs
    FROM sub_tenants WHERE tenants >= 1
    GROUP BY parent_agent_id
  ), eligible AS (
    SELECT q.agent_id, q.qualifying_subs, COALESCE(pe.tenants,0)::int AS personal_tenants
    FROM qualifying q
    LEFT JOIN personal pe ON pe.agent_id = q.agent_id
    WHERE q.qualifying_subs >= v_cfg.required_sub_agents
      AND COALESCE(pe.tenants,0) >= v_cfg.required_main_agent_tenants
  ), upserted AS (
    INSERT INTO public.service_center_managers
      (agent_id, status, source, qualifying_sub_agents, personal_active_tenants, rule_version)
    SELECT e.agent_id, 'active', 'auto_qualification', e.qualifying_subs, e.personal_tenants, v_cfg.rule_version
    FROM eligible e
    ON CONFLICT (agent_id) DO UPDATE
      SET qualifying_sub_agents = EXCLUDED.qualifying_sub_agents,
          personal_active_tenants = EXCLUDED.personal_active_tenants,
          rule_version = EXCLUDED.rule_version,
          updated_at = now()
    RETURNING 1
  )
  SELECT count(*)::int INTO v_tagged FROM upserted;

  RETURN jsonb_build_object('success', true, 'tagged', v_tagged);
END; $$;

-- Approving a service center request tags the agent as a manager immediately.
CREATE OR REPLACE FUNCTION public.tag_service_center_manager_on_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' AND COALESCE(OLD.status,'') <> 'approved' THEN
    INSERT INTO public.service_center_managers
      (agent_id, status, source, qualifying_sub_agents, personal_active_tenants, rule_version, tagged_by)
    VALUES (
      NEW.agent_id, 'active', 'request_approved',
      COALESCE(NEW.qualifying_sub_agents_at_submission,0),
      COALESCE(NEW.personal_active_tenants_at_submission,0),
      NEW.rule_version, NEW.reviewed_by
    )
    ON CONFLICT (agent_id) DO UPDATE
      SET status = 'active',
          source = 'request_approved',
          revoked_at = NULL,
          revoke_reason = NULL,
          updated_at = now();
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_tag_service_center_manager_on_approval ON public.service_center_requests;
CREATE TRIGGER trg_tag_service_center_manager_on_approval
  AFTER UPDATE ON public.service_center_requests
  FOR EACH ROW EXECUTE FUNCTION public.tag_service_center_manager_on_approval();

-- Initial backfill of qualifying agents
SELECT public.sync_service_center_manager_tags();