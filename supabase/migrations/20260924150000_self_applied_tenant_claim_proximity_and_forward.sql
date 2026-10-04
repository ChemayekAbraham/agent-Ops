-- P1 #6 — Tenant self-application: GPS + phone, agent-proximity check,
-- "claim this tenant" support and forwarding a claim to another agent.
-- See docs/HANDOVER/121-self-applied-tenant-claim-and-readiness-gate.md.
--
-- What this changes:
--   1. geo_distance_km()            — one reusable haversine (km).
--   2. agent_last_known_location()  — best available GPS for an agent.
--   3. tenant_rent_intake_requests  — proximity, claim-GPS and forward columns.
--   4. submit_tenant_rent_intake    — GPS now mandatory; records how far the
--                                     assigned agent is from the tenant.
--   5. tenant_rent_intake_decide    — claim now requires the claiming agent's
--                                     GPS and records the tenant↔agent distance;
--                                     new 'forward' action; pre-linked rent
--                                     requests (self-onboarding) get their agent
--                                     set on claim (status stays pending).
--   6. enqueue_rent_request_for_claim + AFTER INSERT trigger — an agentless
--      self-applied rent_request (tenants-onboarding with no referrer) lands in
--      the claim queue instead of sitting in `pending` with nobody to pick it up.
--      The intake form that fed the queue has been unreachable since 2026-09-16
--      (TenantRentRequestCard redirects to /tenants-onboarding).

-- Take every lock up front, in a fixed order. Altering the intake table first
-- and then touching rent_requests deadlocked against live readers of both.
-- (DO block: holds until commit when run in a transaction, harmless otherwise.)
DO $$ BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.rent_requests IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.tenant_rent_intake_requests, public.tenant_rent_intake_events IN ACCESS EXCLUSIVE MODE;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Distance helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geo_distance_km(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision
) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p_lat1 IS NULL OR p_lng1 IS NULL OR p_lat2 IS NULL OR p_lng2 IS NULL THEN NULL
    ELSE round((6371 * 2 * asin(sqrt(
           power(sin(radians(p_lat2 - p_lat1) / 2), 2)
           + cos(radians(p_lat1)) * cos(radians(p_lat2))
             * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
         )))::numeric, 3)
  END
$$;

-- ---------------------------------------------------------------------------
-- 2. Agent's best known location: freshest of a field visit, a device fix or
--    the GPS pin of a rent request they raised (agent-led requests require the
--    agent at the house), falling back to their service centre, then residence.
--    (0,0) is skipped: 5,991 of 6,031 agent_visits in the 30 days to
--    2026-09-24 were written at null island by a GPS-less check-in path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_last_known_location(p_agent_id uuid)
RETURNS TABLE (latitude double precision, longitude double precision, source text, captured_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH live AS (
    SELECT v.latitude::double precision AS latitude, v.longitude::double precision AS longitude,
           'agent_visit'::text AS source, v.checked_in_at AS captured_at
      FROM public.agent_visits v
     WHERE v.agent_id = p_agent_id AND v.latitude IS NOT NULL AND v.longitude IS NOT NULL
       AND NOT (abs(v.latitude) < 0.001 AND abs(v.longitude) < 0.001)
    UNION ALL
    SELECT u.latitude::double precision, u.longitude::double precision, 'device_location', u.captured_at
      FROM public.user_locations u
     WHERE u.user_id = p_agent_id AND u.latitude IS NOT NULL AND u.longitude IS NOT NULL
       AND NOT (abs(u.latitude) < 0.001 AND abs(u.longitude) < 0.001)
    UNION ALL
    SELECT r.request_latitude, r.request_longitude, 'rent_request_pin', r.created_at
      FROM public.rent_requests r
     WHERE r.agent_id = p_agent_id AND r.request_latitude IS NOT NULL AND r.request_longitude IS NOT NULL
       AND NOT (abs(r.request_latitude) < 0.001 AND abs(r.request_longitude) < 0.001)
  ), fallback AS (
    SELECT s.latitude::double precision AS latitude, s.longitude::double precision AS longitude,
           'service_centre'::text AS source, NULL::timestamptz AS captured_at, 1 AS rank
      FROM public.service_centre_setups s
     WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
       AND (s.agent_id = p_agent_id OR EXISTS (
             SELECT 1 FROM public.service_centre_agent_assignments a
              WHERE a.service_centre_id = s.id AND a.agent_id = p_agent_id AND a.status = 'active'))
    UNION ALL
    SELECT p.residence_lat::double precision, p.residence_lng::double precision, 'residence', NULL, 2
      FROM public.profiles p
     WHERE p.id = p_agent_id AND p.residence_lat IS NOT NULL AND p.residence_lng IS NOT NULL
  )
  (SELECT latitude, longitude, source, captured_at FROM live ORDER BY captured_at DESC NULLS LAST LIMIT 1)
  UNION ALL
  (SELECT latitude, longitude, source, captured_at FROM fallback
    WHERE NOT EXISTS (SELECT 1 FROM live) ORDER BY rank LIMIT 1)
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.agent_last_known_location(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_last_known_location(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Intake columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_rent_intake_requests
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'intake_form',
  ADD COLUMN IF NOT EXISTS assigned_agent_distance_km numeric,
  ADD COLUMN IF NOT EXISTS assigned_agent_location_source text,
  ADD COLUMN IF NOT EXISTS claim_latitude double precision,
  ADD COLUMN IF NOT EXISTS claim_longitude double precision,
  ADD COLUMN IF NOT EXISTS claim_distance_km numeric,
  ADD COLUMN IF NOT EXISTS claim_proximity text,
  ADD COLUMN IF NOT EXISTS forwarded_from_agent_id uuid,
  ADD COLUMN IF NOT EXISTS forwarded_by uuid,
  ADD COLUMN IF NOT EXISTS forwarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS forward_reason text,
  ADD COLUMN IF NOT EXISTS forward_count integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE public.tenant_rent_intake_requests
    ADD CONSTRAINT tenant_rent_intake_requests_source_check
    CHECK (source IN ('intake_form','self_onboarding'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.tenant_rent_intake_requests
    ADD CONSTRAINT tenant_rent_intake_requests_claim_proximity_check
    CHECK (claim_proximity IS NULL OR claim_proximity IN ('near','far'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_rent_intake_requests_rent_request_uidx
  ON public.tenant_rent_intake_requests (rent_request_id) WHERE rent_request_id IS NOT NULL;

ALTER TABLE public.tenant_rent_intake_events
  DROP CONSTRAINT IF EXISTS tenant_rent_intake_events_event_type_check;
ALTER TABLE public.tenant_rent_intake_events
  ADD CONSTRAINT tenant_rent_intake_events_event_type_check
  CHECK (event_type IN ('created','assigned','claimed','visit_verified','approved','declined',
                        'rent_request_raised','forwarded'));

-- Claims farther than this from the tenant's pin are flagged 'far' (not blocked).
CREATE OR REPLACE FUNCTION public.intake_claim_near_km() RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT 10::numeric $$;

-- ---------------------------------------------------------------------------
-- Shared routing: nearest active service centre + its newest active agent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.intake_route_to_nearest_centre(p_lat double precision, p_lng double precision)
RETURNS TABLE (service_centre_id uuid, service_centre_name text, agent_id uuid, distance_km numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_centre record;
  v_agent uuid;
BEGIN
  SELECT s.id, s.location_name, s.agent_id,
         public.geo_distance_km(p_lat, p_lng, s.latitude, s.longitude) AS dist
    INTO v_centre
    FROM public.service_centre_setups s
   WHERE s.status IN ('verified','active','approved','paid')
     AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
   ORDER BY public.geo_distance_km(p_lat, p_lng, s.latitude, s.longitude) NULLS LAST, s.created_at DESC
   LIMIT 1;

  IF v_centre.id IS NULL THEN
    RETURN;
  END IF;

  SELECT a.agent_id INTO v_agent
    FROM public.service_centre_agent_assignments a
   WHERE a.service_centre_id = v_centre.id AND a.status = 'active'
   ORDER BY a.assigned_at DESC NULLS LAST
   LIMIT 1;

  service_centre_id := v_centre.id;
  service_centre_name := v_centre.location_name;
  agent_id := coalesce(v_agent, v_centre.agent_id);
  distance_km := v_centre.dist;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.intake_route_to_nearest_centre(double precision, double precision) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. submit_tenant_rent_intake — GPS mandatory, agent distance recorded.
--    Signature unchanged so existing callers keep resolving.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_tenant_rent_intake(
  p_rent_amount numeric, p_landlord_name text, p_landlord_phone text,
  p_village_name text DEFAULT NULL, p_district_name text DEFAULT NULL,
  p_location_name text DEFAULT NULL, p_latitude numeric DEFAULT NULL,
  p_longitude numeric DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth.uid();
  v_profile record;
  v_route record;
  v_loc record;
  v_agent_distance numeric;
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
  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION 'Pin your house location (GPS) before sending your rent request';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tenant_rent_intake_requests
    WHERE tenant_id = v_tenant
      AND status IN ('submitted','claimed','visit_verified','approved')
  ) THEN
    RAISE EXCEPTION 'You already have a rent request being reviewed';
  END IF;

  SELECT full_name, phone INTO v_profile FROM public.profiles WHERE id = v_tenant;
  IF coalesce(trim(v_profile.phone), '') = '' THEN
    RAISE EXCEPTION 'Add your phone number to your profile so the agent can call you';
  END IF;

  SELECT * INTO v_route FROM public.intake_route_to_nearest_centre(p_latitude, p_longitude);

  -- Always run the lookup so v_loc is assigned (all-null when no agent).
  SELECT * INTO v_loc FROM public.agent_last_known_location(v_route.agent_id);
  v_agent_distance := public.geo_distance_km(p_latitude, p_longitude, v_loc.latitude, v_loc.longitude);

  INSERT INTO public.tenant_rent_intake_requests (
    tenant_id, tenant_name, tenant_phone, rent_amount, location_name, village_name,
    district_name, latitude, longitude, landlord_name, landlord_phone, tenant_note,
    service_centre_id, service_centre_name, assigned_agent_id, distance_km,
    assigned_agent_distance_km, assigned_agent_location_source, source
  ) VALUES (
    v_tenant, v_profile.full_name, v_profile.phone, p_rent_amount, p_location_name, p_village_name,
    p_district_name, p_latitude, p_longitude, trim(p_landlord_name), trim(p_landlord_phone), p_note,
    v_route.service_centre_id, v_route.service_centre_name, v_route.agent_id, v_route.distance_km,
    v_agent_distance, v_loc.source, 'intake_form'
  ) RETURNING id INTO v_id;

  INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
  VALUES (v_id, 'created', v_tenant, jsonb_build_object('rent_amount', p_rent_amount));

  IF v_route.service_centre_id IS NOT NULL THEN
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
    VALUES (v_id, 'assigned', v_tenant, jsonb_build_object(
      'service_centre_id', v_route.service_centre_id, 'agent_id', v_route.agent_id,
      'distance_km', v_route.distance_km, 'agent_distance_km', v_agent_distance,
      'agent_location_source', v_loc.source));
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata, description)
  VALUES ('tenant_rent_intake.submitted', v_tenant, 'tenant_rent_intake_requests', v_id,
          jsonb_build_object('service_centre_id', v_route.service_centre_id, 'agent_id', v_route.agent_id,
                             'rent_amount', p_rent_amount, 'distance_km', v_route.distance_km,
                             'agent_distance_km', v_agent_distance),
          'Tenant requested rent help');

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

  RETURN jsonb_build_object(
    'request_id', v_id,
    'service_centre_id', v_route.service_centre_id,
    'service_centre_name', v_route.service_centre_name,
    'assigned_agent_id', v_route.agent_id,
    'distance_km', v_route.distance_km,
    'agent_distance_km', v_agent_distance
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. tenant_rent_intake_decide — adds p_to_agent_id for 'forward'.
--    Dropped first: adding a defaulted param would otherwise create an
--    ambiguous overload for named-argument callers.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.tenant_rent_intake_decide(uuid, text, text, numeric, numeric, uuid);

CREATE OR REPLACE FUNCTION public.tenant_rent_intake_decide(
  p_request_id uuid, p_action text, p_reason text DEFAULT NULL,
  p_latitude numeric DEFAULT NULL, p_longitude numeric DEFAULT NULL,
  p_rent_request_id uuid DEFAULT NULL, p_to_agent_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_req record;
  v_allowed boolean;
  v_is_ops boolean;
  v_status text;
  v_distance numeric;
  v_proximity text;
  v_loc record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_req FROM public.tenant_rent_intake_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  v_is_ops := public.has_role(v_actor, 'manager') OR public.has_role(v_actor, 'super_admin')
           OR public.has_role(v_actor, 'agent_ops') OR public.has_role(v_actor, 'tenant_ops');

  SELECT (
    v_req.assigned_agent_id = v_actor
    OR EXISTS (SELECT 1 FROM public.service_centre_setups s
               WHERE s.id = v_req.service_centre_id AND s.agent_id = v_actor)
    OR EXISTS (SELECT 1 FROM public.service_centre_agent_assignments a
               WHERE a.service_centre_id = v_req.service_centre_id
                 AND a.agent_id = v_actor AND a.status = 'active')
    OR v_is_ops
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'You are not assigned to this request';
  END IF;

  IF p_action = 'claim' THEN
    IF v_req.status <> 'submitted' THEN
      RAISE EXCEPTION 'This request has already been claimed';
    END IF;
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
      RAISE EXCEPTION 'Turn on your location to claim this tenant — we check how close you are to their house';
    END IF;

    v_distance := public.geo_distance_km(v_req.latitude, v_req.longitude, p_latitude, p_longitude);
    v_proximity := CASE WHEN v_distance IS NULL THEN NULL
                        WHEN v_distance <= public.intake_claim_near_km() THEN 'near'
                        ELSE 'far' END;
    v_status := 'claimed';
    UPDATE public.tenant_rent_intake_requests
       SET status = v_status, claimed_by = v_actor, claimed_at = now(),
           assigned_agent_id = coalesce(assigned_agent_id, v_actor),
           claim_latitude = p_latitude, claim_longitude = p_longitude,
           claim_distance_km = v_distance, claim_proximity = v_proximity
     WHERE id = p_request_id;
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
    VALUES (p_request_id, 'claimed', v_actor, jsonb_build_object(
      'latitude', p_latitude, 'longitude', p_longitude,
      'distance_km', v_distance, 'proximity', v_proximity));

    -- Self-applied rent request with no agent: the claimer becomes its agent.
    -- Status stays `pending` (Agent Ops is next): guard_rent_request_agent_updates
    -- forbids an agent moving pending -> service_center_review, and the claim +
    -- site visit already covers what the service-centre step checks.
    IF v_req.rent_request_id IS NOT NULL THEN
      UPDATE public.rent_requests
         SET agent_id = v_actor
       WHERE id = v_req.rent_request_id AND agent_id IS NULL AND status = 'pending';
    END IF;

  ELSIF p_action = 'forward' THEN
    IF v_req.status NOT IN ('submitted','claimed','visit_verified') THEN
      RAISE EXCEPTION 'Only open requests can be forwarded';
    END IF;
    IF NOT (v_is_ops OR v_req.claimed_by = v_actor OR v_req.assigned_agent_id = v_actor) THEN
      RAISE EXCEPTION 'Only the agent handling this tenant can forward it';
    END IF;
    IF p_to_agent_id IS NULL OR p_to_agent_id = v_actor THEN
      RAISE EXCEPTION 'Choose another agent to forward this tenant to';
    END IF;
    IF coalesce(length(trim(p_reason)), 0) < 5 THEN
      RAISE EXCEPTION 'Say why you are forwarding this tenant';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = p_to_agent_id AND ur.enabled IS NOT FALSE
         AND ur.role IN ('agent','senior_agent','sub_agent')
    ) OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_to_agent_id AND p.is_frozen IS TRUE) THEN
      RAISE EXCEPTION 'That person is not an active agent';
    END IF;

    SELECT * INTO v_loc FROM public.agent_last_known_location(p_to_agent_id);
    v_distance := public.geo_distance_km(v_req.latitude, v_req.longitude, v_loc.latitude, v_loc.longitude);

    v_status := 'submitted';
    UPDATE public.tenant_rent_intake_requests
       SET status = v_status, assigned_agent_id = p_to_agent_id,
           claimed_by = NULL, claimed_at = NULL,
           claim_latitude = NULL, claim_longitude = NULL, claim_distance_km = NULL, claim_proximity = NULL,
           forwarded_from_agent_id = coalesce(v_req.claimed_by, v_req.assigned_agent_id),
           forwarded_by = v_actor, forwarded_at = now(), forward_reason = trim(p_reason),
           forward_count = forward_count + 1,
           assigned_agent_distance_km = v_distance, assigned_agent_location_source = v_loc.source
     WHERE id = p_request_id;
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, note, metadata)
    VALUES (p_request_id, 'forwarded', v_actor, trim(p_reason), jsonb_build_object(
      'from_agent_id', coalesce(v_req.claimed_by, v_req.assigned_agent_id),
      'to_agent_id', p_to_agent_id, 'to_agent_distance_km', v_distance,
      'to_agent_location_source', v_loc.source));

    -- Undo the agent the previous claim put on a self-applied rent request,
    -- but only while it is still untouched in `pending`.
    IF v_req.rent_request_id IS NOT NULL AND v_req.claimed_by IS NOT NULL THEN
      UPDATE public.rent_requests
         SET agent_id = NULL
       WHERE id = v_req.rent_request_id
         AND agent_id = v_req.claimed_by
         AND assigned_agent_id IS NULL
         AND status = 'pending'
         AND agent_ops_reviewed_at IS NULL;
    END IF;

    -- No in-app notification: block_notification_inserts drops every
    -- non-allowlisted type. The target sees it in their queue (assigned_agent_id).

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
            jsonb_build_object('latitude', p_latitude, 'longitude', p_longitude,
                               'distance_km', public.geo_distance_km(v_req.latitude, v_req.longitude, p_latitude, p_longitude)));

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
    -- A self-applied request already has its rent_request: skip "raise".
    v_status := CASE WHEN v_req.rent_request_id IS NOT NULL THEN 'rent_requested' ELSE 'approved' END;
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
          jsonb_build_object('status', v_status, 'reason', p_reason,
                             'distance_km', v_distance, 'proximity', v_proximity,
                             'to_agent_id', p_to_agent_id),
          'Tenant rent request ' || p_action);

  RETURN jsonb_build_object('request_id', p_request_id, 'status', v_status,
                            'distance_km', v_distance, 'proximity', v_proximity);
END;
$function$;

REVOKE ALL ON FUNCTION public.tenant_rent_intake_decide(uuid, text, text, numeric, numeric, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_rent_intake_decide(uuid, text, text, numeric, numeric, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Agentless self-applied rent requests → claim queue.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_rent_request_for_claim(p_rent_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rr record;
  v_profile record;
  v_landlord record;
  v_route record;
  v_loc record;
  v_agent_distance numeric;
  v_id uuid;
BEGIN
  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id;
  IF v_rr.id IS NULL OR v_rr.agent_id IS NOT NULL OR v_rr.assigned_agent_id IS NOT NULL
     OR v_rr.status <> 'pending' THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenant_rent_intake_requests WHERE rent_request_id = v_rr.id) THEN
    RETURN NULL;
  END IF;

  SELECT full_name, phone, village, district INTO v_profile FROM public.profiles WHERE id = v_rr.tenant_id;
  SELECT name, coalesce(nullif(trim(phone), ''), mobile_money_number) AS phone
    INTO v_landlord FROM public.landlords WHERE id = v_rr.landlord_id;

  SELECT * INTO v_route FROM public.intake_route_to_nearest_centre(v_rr.request_latitude, v_rr.request_longitude);
  SELECT * INTO v_loc FROM public.agent_last_known_location(v_route.agent_id);
  v_agent_distance := public.geo_distance_km(v_rr.request_latitude, v_rr.request_longitude, v_loc.latitude, v_loc.longitude);

  INSERT INTO public.tenant_rent_intake_requests (
    tenant_id, tenant_name, tenant_phone, rent_amount, location_name, village_name, district_name,
    latitude, longitude, landlord_name, landlord_phone,
    service_centre_id, service_centre_name, assigned_agent_id, distance_km,
    assigned_agent_distance_km, assigned_agent_location_source, rent_request_id, source
  ) VALUES (
    v_rr.tenant_id, v_profile.full_name, v_profile.phone, v_rr.rent_amount,
    nullif(concat_ws(', ', v_profile.village, v_profile.district), ''), v_profile.village, v_profile.district,
    v_rr.request_latitude, v_rr.request_longitude,
    coalesce(nullif(trim(v_landlord.name), ''), 'Landlord'), coalesce(v_landlord.phone, ''),
    v_route.service_centre_id, v_route.service_centre_name, v_route.agent_id, v_route.distance_km,
    v_agent_distance, v_loc.source, v_rr.id, 'self_onboarding'
  ) RETURNING id INTO v_id;

  INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
  VALUES (v_id, 'created', v_rr.tenant_id,
          jsonb_build_object('rent_amount', v_rr.rent_amount, 'source', 'self_onboarding',
                             'rent_request_id', v_rr.id));
  IF v_route.service_centre_id IS NOT NULL THEN
    INSERT INTO public.tenant_rent_intake_events (request_id, event_type, actor_id, metadata)
    VALUES (v_id, 'assigned', v_rr.tenant_id, jsonb_build_object(
      'service_centre_id', v_route.service_centre_id, 'agent_id', v_route.agent_id,
      'distance_km', v_route.distance_km, 'agent_distance_km', v_agent_distance,
      'agent_location_source', v_loc.source));
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_rent_request_for_claim(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_enqueue_agentless_rent_request()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Never let queueing break the rent request itself.
  BEGIN
    PERFORM public.enqueue_rent_request_for_claim(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.system_events (event_type, related_entity_type, related_entity_id, description, metadata)
    VALUES ('tenant_rent_intake.enqueue_failed', 'rent_requests', NEW.id,
            'Could not add agentless rent request to the claim queue',
            jsonb_build_object('error', SQLERRM));
  END;
  RETURN NULL;
END;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enqueue_agentless_rent_request'
              AND tgrelid = 'public.rent_requests'::regclass) THEN
    DROP TRIGGER trg_enqueue_agentless_rent_request ON public.rent_requests;
  END IF;
END $$;
CREATE TRIGGER trg_enqueue_agentless_rent_request
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW
  WHEN (NEW.agent_id IS NULL AND NEW.assigned_agent_id IS NULL AND NEW.status = 'pending')
  EXECUTE FUNCTION public.trg_enqueue_agentless_rent_request();

-- Backfill: agentless requests still in `pending` (1 on 2026-09-24).
SELECT public.enqueue_rent_request_for_claim(id)
  FROM public.rent_requests
 WHERE agent_id IS NULL AND assigned_agent_id IS NULL AND status = 'pending';
