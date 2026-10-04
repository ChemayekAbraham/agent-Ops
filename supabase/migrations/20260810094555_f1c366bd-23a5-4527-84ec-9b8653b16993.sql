-- 1. Service centre columns on landlords ------------------------------------
ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS service_center_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS service_center_manager_id uuid,
  ADD COLUMN IF NOT EXISTS service_center_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS service_center_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_center_comment text;

ALTER TABLE public.lc1_chairpersons
  ADD COLUMN IF NOT EXISTS service_center_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS service_center_manager_id uuid,
  ADD COLUMN IF NOT EXISTS service_center_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS service_center_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_center_comment text;

CREATE INDEX IF NOT EXISTS idx_landlords_sc_queue
  ON public.landlords (service_center_manager_id, service_center_status);
CREATE INDEX IF NOT EXISTS idx_lc1_sc_queue
  ON public.lc1_chairpersons (service_center_manager_id, service_center_status);

-- 2. Routing trigger ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_verification_to_service_center()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manager uuid;
BEGIN
  -- Only route brand-new rows that have not already been placed somewhere.
  IF NEW.service_center_status IS DISTINCT FROM 'not_required'
     OR NEW.service_center_manager_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.registered_by IS NULL THEN
    RETURN NEW;
  END IF;

  v_manager := public.resolve_service_center_manager_for_agent(NEW.registered_by);

  IF v_manager IS NOT NULL THEN
    NEW.service_center_manager_id := v_manager;
    NEW.service_center_status := 'pending';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_landlord_to_service_center ON public.landlords;
CREATE TRIGGER trg_route_landlord_to_service_center
  BEFORE INSERT ON public.landlords
  FOR EACH ROW EXECUTE FUNCTION public.route_verification_to_service_center();

DROP TRIGGER IF EXISTS trg_route_lc1_to_service_center ON public.lc1_chairpersons;
CREATE TRIGGER trg_route_lc1_to_service_center
  BEFORE INSERT ON public.lc1_chairpersons
  FOR EACH ROW EXECUTE FUNCTION public.route_verification_to_service_center();

-- 3. Manager queue -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_service_center_verification_queue(p_manager_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_manager uuid := COALESCE(p_manager_id, auth.uid());
  v_landlords jsonb;
  v_lc1 jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_manager <> v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_landlords
  FROM (
    SELECT jsonb_build_object(
      'id', l.id,
      'name', l.name,
      'phone', l.phone,
      'village', l.village,
      'district', l.district,
      'property_address', l.property_address,
      'monthly_rent', l.monthly_rent,
      'number_of_houses', l.number_of_houses,
      'latitude', l.latitude,
      'longitude', l.longitude,
      'created_at', l.created_at,
      'agent_id', l.registered_by,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'service_center_status', l.service_center_status
    ) AS x
    FROM public.landlords l
    LEFT JOIN public.profiles ap ON ap.id = l.registered_by
    WHERE l.service_center_status = 'pending'
      AND l.service_center_manager_id = v_manager
      AND COALESCE(l.verified, false) = false
      AND COALESCE(l.verification_status, 'pending') <> 'verified'
    ORDER BY l.created_at DESC
    LIMIT 200
  ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_lc1
  FROM (
    SELECT jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'phone', c.phone,
      'village', c.village,
      'district', c.district,
      'parish', c.parish,
      'sub_county', c.sub_county,
      'created_at', COALESCE(c.registered_at, c.created_at),
      'agent_id', c.registered_by,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'service_center_status', c.service_center_status
    ) AS x
    FROM public.lc1_chairpersons c
    LEFT JOIN public.profiles ap ON ap.id = c.registered_by
    WHERE c.service_center_status = 'pending'
      AND c.service_center_manager_id = v_manager
      AND COALESCE(c.verified, false) = false
      AND COALESCE(c.verification_status, 'pending') <> 'verified'
    ORDER BY COALESCE(c.registered_at, c.created_at) DESC
    LIMIT 200
  ) s;

  RETURN jsonb_build_object(
    'landlords', v_landlords,
    'lc1', v_lc1,
    'pending_count', jsonb_array_length(v_landlords) + jsonb_array_length(v_lc1)
  );
END;
$$;

-- 4. Manager review ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_center_review_verification(
  p_kind text,
  p_record_id uuid,
  p_decision text,
  p_comment text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean := public.is_ops_role(auth.uid());
  v_manager uuid;
  v_agent uuid;
  v_status text;
  v_new text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_kind NOT IN ('landlord','lc1') THEN RAISE EXCEPTION 'invalid kind'; END IF;
  IF p_decision NOT IN ('pass','return') THEN RAISE EXCEPTION 'invalid decision'; END IF;
  IF p_decision = 'return' AND COALESCE(btrim(p_comment),'') = '' THEN
    RAISE EXCEPTION 'a reason is required when returning a record';
  END IF;

  v_new := CASE WHEN p_decision = 'pass' THEN 'passed' ELSE 'returned' END;

  IF p_kind = 'landlord' THEN
    SELECT service_center_manager_id, service_center_status, registered_by
      INTO v_manager, v_status, v_agent
      FROM public.landlords WHERE id = p_record_id FOR UPDATE;
  ELSE
    SELECT service_center_manager_id, service_center_status, registered_by
      INTO v_manager, v_status, v_agent
      FROM public.lc1_chairpersons WHERE id = p_record_id FOR UPDATE;
  END IF;

  IF v_status IS NULL THEN RAISE EXCEPTION 'record not found'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'this record is not awaiting service centre review';
  END IF;
  IF NOT v_is_ops AND v_manager IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'not authorised to review this record';
  END IF;

  IF p_kind = 'landlord' THEN
    UPDATE public.landlords
       SET service_center_status = v_new,
           service_center_reviewed_by = v_actor,
           service_center_reviewed_at = now(),
           service_center_comment = p_comment,
           updated_at = now()
     WHERE id = p_record_id;
  ELSE
    UPDATE public.lc1_chairpersons
       SET service_center_status = v_new,
           service_center_reviewed_by = v_actor,
           service_center_reviewed_at = now(),
           service_center_comment = p_comment
     WHERE id = p_record_id;
  END IF;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'listing_created',
    v_actor,
    CASE WHEN p_kind = 'landlord' THEN 'landlord' ELSE 'lc1_chairperson' END,
    p_record_id,
    jsonb_build_object(
      'action', CASE WHEN p_decision = 'pass' THEN 'service_center_passed' ELSE 'service_center_returned' END,
      'kind', p_kind,
      'service_center_manager_id', v_manager,
      'registering_agent_id', v_agent,
      'comment', p_comment,
      'reviewed_by_ops', v_is_ops
    )
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor,
    'service_center_verification_review',
    CASE WHEN p_kind = 'landlord' THEN 'landlords' ELSE 'lc1_chairpersons' END,
    p_record_id,
    jsonb_build_object('decision', p_decision, 'reason', COALESCE(p_comment, 'Passed service centre vetting'))
  );

  RETURN jsonb_build_object('success', true, 'id', p_record_id, 'kind', p_kind, 'service_center_status', v_new);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_service_center_verification_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_center_review_verification(text, uuid, text, text) TO authenticated;

-- 5. Expose the service centre state to the LC1 inbox ------------------------
CREATE OR REPLACE VIEW public.v_lc1_verification_inbox AS
 SELECT c.id AS lc1_id,
    r.id AS request_id,
    c.name AS lc1_name,
    c.phone AS lc1_phone,
    c.village AS lc1_village,
    c.district AS lc1_district,
    c.region AS lc1_region,
    c.parish AS lc1_parish,
    c.sub_county AS lc1_sub_county,
    COALESCE(c.verification_status, 'pending'::text) AS status,
    c.verification_reason AS reason,
    c.verified AS verified_flag,
    c.verified_at,
    c.verified_by,
    vp.full_name AS reviewer_name,
    c.registered_by AS agent_id,
    COALESCE(r.agent_name, ap.full_name) AS agent_name,
    COALESCE(r.agent_phone, ap.phone) AS agent_phone,
    r.note AS agent_note,
    r.reject_comment,
    r.status AS request_status,
    r.resolved_at,
    rp.full_name AS resolved_by_name,
        CASE
            WHEN r.id IS NOT NULL THEN 'agent_request'::text
            ELSE 'registration'::text
        END AS source,
    COALESCE(r.created_at, c.registered_at, c.created_at) AS requested_at,
    c.created_at AS lc1_created_at,
    c.verification_bonus_paid,
    ( SELECT count(*) AS count
           FROM landlords l
          WHERE l.phone IS NOT NULL AND l.phone = c.phone) AS linked_landlords,
    r.id IS NOT NULL AND COALESCE(r.status, 'pending'::text) = 'pending'::text AS agent_request_open,
    COALESCE(rr.open_count, 0::bigint) AS open_rent_requests,
    COALESCE(rr.open_count, 0::bigint) > 0 AS has_open_rent_request,
    COALESCE(c.service_center_status, 'not_required'::text) AS service_center_status,
    c.service_center_manager_id
   FROM lc1_chairpersons c
     LEFT JOIN LATERAL ( SELECT r2.id,
            r2.agent_name,
            r2.agent_phone,
            r2.note,
            r2.status,
            r2.reject_comment,
            r2.resolved_by,
            r2.resolved_at,
            r2.created_at
           FROM lc1_verification_requests r2
          WHERE r2.lc1_id = c.id
          ORDER BY (COALESCE(r2.resolved_at, r2.created_at)) DESC
         LIMIT 1) r ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS open_count
           FROM rent_requests x
          WHERE x.lc1_id = c.id AND (x.status = ANY (ARRAY['pending'::text, 'agent_ops_approved'::text, 'tenant_ops_approved'::text, 'landlord_ops_approved'::text, 'coo_approved'::text]))) rr ON true
     LEFT JOIN profiles ap ON ap.id = c.registered_by
     LEFT JOIN profiles vp ON vp.id = c.verified_by
     LEFT JOIN profiles rp ON rp.id = r.resolved_by;