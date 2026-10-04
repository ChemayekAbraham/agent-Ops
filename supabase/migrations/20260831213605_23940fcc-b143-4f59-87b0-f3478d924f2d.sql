CREATE TABLE public.tenant_rent_intake_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL,
  tenant_name text,
  tenant_phone text,
  rent_amount numeric NOT NULL CHECK (rent_amount > 0),
  location_name text,
  village_name text,
  district_name text,
  latitude numeric,
  longitude numeric,
  landlord_name text NOT NULL,
  landlord_phone text NOT NULL,
  tenant_note text,
  service_centre_id uuid REFERENCES public.service_centre_setups(id) ON DELETE SET NULL,
  service_centre_name text,
  assigned_agent_id uuid,
  distance_km numeric,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','claimed','visit_verified','approved','declined','rent_requested')),
  claimed_by uuid,
  claimed_at timestamptz,
  visit_verified_by uuid,
  visit_verified_at timestamptz,
  visit_latitude numeric,
  visit_longitude numeric,
  decided_by uuid,
  decided_at timestamptz,
  decline_reason text,
  rent_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.tenant_rent_intake_requests TO authenticated;
GRANT ALL ON public.tenant_rent_intake_requests TO service_role;

ALTER TABLE public.tenant_rent_intake_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenants view own rent intake requests"
ON public.tenant_rent_intake_requests FOR SELECT TO authenticated
USING (tenant_id = auth.uid());

CREATE POLICY "Tenants create own rent intake requests"
ON public.tenant_rent_intake_requests FOR INSERT TO authenticated
WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "Assigned agents view routed rent intake requests"
ON public.tenant_rent_intake_requests FOR SELECT TO authenticated
USING (
  assigned_agent_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.service_centre_setups s
    WHERE s.id = tenant_rent_intake_requests.service_centre_id
      AND s.agent_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.service_centre_agent_assignments a
    WHERE a.service_centre_id = tenant_rent_intake_requests.service_centre_id
      AND a.agent_id = auth.uid()
      AND a.status = 'active'
  )
);

CREATE POLICY "Assigned agents update routed rent intake requests"
ON public.tenant_rent_intake_requests FOR UPDATE TO authenticated
USING (
  assigned_agent_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.service_centre_setups s
    WHERE s.id = tenant_rent_intake_requests.service_centre_id
      AND s.agent_id = auth.uid()
  )
)
WITH CHECK (
  assigned_agent_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.service_centre_setups s
    WHERE s.id = tenant_rent_intake_requests.service_centre_id
      AND s.agent_id = auth.uid()
  )
);

CREATE POLICY "Ops staff view all rent intake requests"
ON public.tenant_rent_intake_requests FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'tenant_ops')
  OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo')
);

CREATE INDEX idx_tri_tenant ON public.tenant_rent_intake_requests (tenant_id, created_at DESC);
CREATE INDEX idx_tri_agent_status ON public.tenant_rent_intake_requests (assigned_agent_id, status, created_at DESC);
CREATE INDEX idx_tri_centre_status ON public.tenant_rent_intake_requests (service_centre_id, status, created_at DESC);

CREATE TABLE public.tenant_rent_intake_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.tenant_rent_intake_requests(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN ('created','assigned','claimed','visit_verified','approved','declined','rent_request_raised')),
  actor_id uuid,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tenant_rent_intake_events TO authenticated;
GRANT ALL ON public.tenant_rent_intake_events TO service_role;

ALTER TABLE public.tenant_rent_intake_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read rent intake events for visible requests"
ON public.tenant_rent_intake_events FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.tenant_rent_intake_requests r
    WHERE r.id = tenant_rent_intake_events.request_id
  )
);

CREATE INDEX idx_trie_request ON public.tenant_rent_intake_events (request_id, created_at DESC);

CREATE TRIGGER update_tenant_rent_intake_requests_updated_at
BEFORE UPDATE ON public.tenant_rent_intake_requests
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.submit_tenant_rent_intake(
  p_rent_amount numeric,
  p_landlord_name text,
  p_landlord_phone text,
  p_village_name text DEFAULT NULL,
  p_district_name text DEFAULT NULL,
  p_location_name text DEFAULT NULL,
  p_latitude numeric DEFAULT NULL,
  p_longitude numeric DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := auth.uid();
  v_profile record;
  v_centre record;
  v_agent uuid;
  v_distance numeric;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_rent_amount IS NULL OR p_rent_amount <= 0 THEN
    RAISE EXCEPTION 'Enter the monthly rent amount';
  END IF;
  IF coalesce(trim(p_landlord_name), '') = '' OR coalesce(trim(p_landlord_phone), '') = '' THEN
    RAISE EXCEPTION 'Landlord name and phone are required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tenant_rent_intake_requests
    WHERE tenant_id = v_tenant
      AND status IN ('submitted','claimed','visit_verified','approved')
  ) THEN
    RAISE EXCEPTION 'You already have a rent request being reviewed';
  END IF;

  SELECT full_name, phone INTO v_profile FROM public.profiles WHERE id = v_tenant;

  SELECT s.*,
         CASE
           WHEN p_latitude IS NULL OR p_longitude IS NULL THEN NULL
           ELSE 111.045 * sqrt(
                  pow(s.latitude - p_latitude, 2)
                  + pow((s.longitude - p_longitude) * cos(radians((s.latitude + p_latitude) / 2)), 2)
                )
         END AS dist
  INTO v_centre
  FROM public.service_centre_setups s
  WHERE s.status IN ('verified','active','approved','paid')
    AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
  ORDER BY (
    CASE
      WHEN p_latitude IS NULL OR p_longitude IS NULL THEN NULL
      ELSE 111.045 * sqrt(
             pow(s.latitude - p_latitude, 2)
             + pow((s.longitude - p_longitude) * cos(radians((s.latitude + p_latitude) / 2)), 2)
           )
    END
  ) NULLS LAST, s.created_at DESC
  LIMIT 1;

  IF v_centre.id IS NOT NULL THEN
    v_distance := v_centre.dist;
    SELECT a.agent_id INTO v_agent
    FROM public.service_centre_agent_assignments a
    WHERE a.service_centre_id = v_centre.id AND a.status = 'active'
    ORDER BY a.assigned_at DESC NULLS LAST
    LIMIT 1;
    v_agent := coalesce(v_agent, v_centre.agent_id);
  END IF;

  INSERT INTO public.tenant_rent_intake_requests (
    tenant_id, tenant_name, tenant_phone, rent_amount, location_name, village_name,
    district_name, latitude, longitude, landlord_name, landlord_phone, tenant_note,
    service_centre_id, service_centre_name, assigned_agent_id, distance_km
  ) VALUES (
    v_tenant, v_profile.full_name, v_profile.phone, p_rent_amount, p_location_name, p_village_name,
    p_district_name, p_latitude, p_longitude, trim(p_landlord_name), trim(p_landlord_phone), p_note,
    v_centre.id, v_centre.location_name, v_agent, v_distance
  ) RETURNING id INTO v_id;

  INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
  VALUES (v_id, 'created', v_tenant, jsonb_build_object('rent_amount', p_rent_amount));

  IF v_centre.id IS NOT NULL THEN
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
    VALUES (v_id, 'assigned', v_tenant, jsonb_build_object(
      'service_centre_id', v_centre.id, 'agent_id', v_agent, 'distance_km', v_distance));
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata, description)
  VALUES ('tenant_rent_intake.submitted', v_tenant, 'tenant_rent_intake_requests', v_id,
          jsonb_build_object('service_centre_id', v_centre.id, 'agent_id', v_agent,
                             'rent_amount', p_rent_amount, 'distance_km', v_distance),
          'Tenant requested rent help');

  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    BEGIN
      PERFORM public.capture_trust_signal(
        p_tenant_id := v_tenant,
        p_signal_type := 'venue_visit',
        p_venue_category := 'residence',
        p_latitude := p_latitude,
        p_longitude := p_longitude,
        p_notes := 'Tenant rent request location'
      );
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'request_id', v_id,
    'service_centre_id', v_centre.id,
    'service_centre_name', v_centre.location_name,
    'assigned_agent_id', v_agent,
    'distance_km', v_distance
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_rent_intake_decide(
  p_request_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_latitude numeric DEFAULT NULL,
  p_longitude numeric DEFAULT NULL,
  p_rent_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_req record;
  v_allowed boolean;
  v_status text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_req FROM public.tenant_rent_intake_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  SELECT (
    v_req.assigned_agent_id = v_actor
    OR EXISTS (SELECT 1 FROM public.service_centre_setups s
               WHERE s.id = v_req.service_centre_id AND s.agent_id = v_actor)
    OR EXISTS (SELECT 1 FROM public.service_centre_agent_assignments a
               WHERE a.service_centre_id = v_req.service_centre_id
                 AND a.agent_id = v_actor AND a.status = 'active')
    OR public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
    OR public.has_role(v_actor, 'agent_ops') OR public.has_role(v_actor, 'tenant_ops')
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'You are not assigned to this request';
  END IF;

  IF p_action = 'claim' THEN
    IF v_req.status <> 'submitted' THEN
      RAISE EXCEPTION 'This request has already been claimed';
    END IF;
    v_status := 'claimed';
    UPDATE public.tenant_rent_intake_requests
       SET status = v_status, claimed_by = v_actor, claimed_at = now(),
           assigned_agent_id = coalesce(assigned_agent_id, v_actor)
     WHERE id = p_request_id;
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id)
    VALUES (p_request_id, 'claimed', v_actor);

  ELSIF p_action = 'verify_visit' THEN
    IF v_req.status NOT IN ('submitted','claimed') THEN
      RAISE EXCEPTION 'Visit cannot be recorded at this stage';
    END IF;
    v_status := 'visit_verified';
    UPDATE public.tenant_rent_intake_requests
       SET status = v_status, visit_verified_by = v_actor, visit_verified_at = now(),
           visit_latitude = p_latitude, visit_longitude = p_longitude,
           claimed_by = coalesce(claimed_by, v_actor), claimed_at = coalesce(claimed_at, now()),
           assigned_agent_id = coalesce(assigned_agent_id, v_actor)
     WHERE id = p_request_id;
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
    VALUES (p_request_id, 'visit_verified', v_actor,
            jsonb_build_object('latitude', p_latitude, 'longitude', p_longitude));

    IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
      BEGIN
        INSERT INTO public.agent_visits (agent_id, tenant_id, latitude, longitude, location_name)
        VALUES (v_actor, v_req.tenant_id, p_latitude, p_longitude, v_req.location_name);
      EXCEPTION WHEN others THEN NULL;
      END;
      BEGIN
        PERFORM public.capture_trust_signal(
          p_tenant_id := v_req.tenant_id,
          p_signal_type := 'venue_visit',
          p_venue_category := 'residence',
          p_latitude := p_latitude,
          p_longitude := p_longitude,
          p_notes := 'Agent verified tenant house for rent request'
        );
      EXCEPTION WHEN others THEN NULL;
      END;
    END IF;

  ELSIF p_action = 'approve' THEN
    IF v_req.status NOT IN ('claimed','visit_verified') THEN
      RAISE EXCEPTION 'Claim and verify the visit before approving';
    END IF;
    v_status := 'approved';
    UPDATE public.tenant_rent_intake_requests
       SET status = v_status, decided_by = v_actor, decided_at = now(), decline_reason = NULL
     WHERE id = p_request_id;
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, note)
    VALUES (p_request_id, 'approved', v_actor, p_reason);

  ELSIF p_action = 'decline' THEN
    IF coalesce(length(trim(p_reason)), 0) < 10 THEN
      RAISE EXCEPTION 'Give a reason of at least 10 characters';
    END IF;
    IF v_req.status IN ('declined','rent_requested') THEN
      RAISE EXCEPTION 'This request is already closed';
    END IF;
    v_status := 'declined';
    UPDATE public.tenant_rent_intake_requests
       SET status = v_status, decided_by = v_actor, decided_at = now(), decline_reason = trim(p_reason)
     WHERE id = p_request_id;
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, note)
    VALUES (p_request_id, 'declined', v_actor, trim(p_reason));

  ELSIF p_action = 'link_rent_request' THEN
    IF v_req.status <> 'approved' THEN
      RAISE EXCEPTION 'Approve the request first';
    END IF;
    IF p_rent_request_id IS NULL THEN
      RAISE EXCEPTION 'Rent request id is required';
    END IF;
    v_status := 'rent_requested';
    UPDATE public.tenant_rent_intake_requests
       SET status = v_status, rent_request_id = p_rent_request_id
     WHERE id = p_request_id;
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
    VALUES (p_request_id, 'rent_request_raised', v_actor,
            jsonb_build_object('rent_request_id', p_rent_request_id));

  ELSE
    RAISE EXCEPTION 'Unknown action %', p_action;
  END IF;

  INSERT INTO public.system_events (event_type, user_id, actor_id, related_entity_type, related_entity_id, metadata, description)
  VALUES ('tenant_rent_intake.' || p_action, v_req.tenant_id, v_actor,
          'tenant_rent_intake_requests', p_request_id,
          jsonb_build_object('status', v_status, 'reason', p_reason),
          'Tenant rent request ' || p_action);

  RETURN jsonb_build_object('request_id', p_request_id, 'status', v_status);
END;
$$;