
-- 1) landlord_funder_links table
CREATE TABLE IF NOT EXISTS public.landlord_funder_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL,
  funder_id uuid NOT NULL,
  linked_by uuid,
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  unlinked_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_landlord_funder_active
  ON public.landlord_funder_links (landlord_id, funder_id)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_lfl_landlord ON public.landlord_funder_links(landlord_id);
CREATE INDEX IF NOT EXISTS idx_lfl_funder   ON public.landlord_funder_links(funder_id);

ALTER TABLE public.landlord_funder_links ENABLE ROW LEVEL SECURITY;

-- 2) Ops-role helper
CREATE OR REPLACE FUNCTION public.is_ops_role(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND enabled = true
      AND role IN ('manager','super_admin','coo','operations')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_ops_role(uuid) TO authenticated;

-- RLS for landlord_funder_links
DROP POLICY IF EXISTS lfl_select_ops ON public.landlord_funder_links;
CREATE POLICY lfl_select_ops ON public.landlord_funder_links
  FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()));

DROP POLICY IF EXISTS lfl_select_agent ON public.landlord_funder_links;
CREATE POLICY lfl_select_agent ON public.landlord_funder_links
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.agent_landlord_assignments a
      WHERE a.agent_id = auth.uid()
        AND a.landlord_id = landlord_funder_links.landlord_id
        AND a.status = 'active'
    )
  );

-- writes only through RPCs (service role / definer), so no INSERT/UPDATE policies for authenticated.

-- 3) ops_update_user_location
CREATE OR REPLACE FUNCTION public.ops_update_user_location(
  p_user_id   uuid,
  p_address   jsonb,
  p_latitude  double precision,
  p_longitude double precision,
  p_accuracy  double precision,
  p_reason    text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean;
  v_is_agent_owner boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  v_is_ops := public.is_ops_role(v_actor);
  v_is_agent_owner := public.has_agent_contact_relationship(v_actor, p_user_id);

  IF NOT (v_is_ops OR v_is_agent_owner) THEN
    RAISE EXCEPTION 'Not authorised to edit this user';
  END IF;

  UPDATE public.profiles SET
    continent  = COALESCE(NULLIF(p_address->>'continent', ''),  continent),
    country    = COALESCE(NULLIF(p_address->>'country', ''),    country),
    region     = COALESCE(NULLIF(p_address->>'region', ''),     region),
    district   = COALESCE(NULLIF(p_address->>'district', ''),   district),
    city       = COALESCE(NULLIF(p_address->>'city', ''),       city),
    town       = COALESCE(NULLIF(p_address->>'town', ''),       town),
    sub_county = COALESCE(NULLIF(p_address->>'sub_county', ''), sub_county),
    parish     = COALESCE(NULLIF(p_address->>'parish', ''),     parish),
    village    = COALESCE(NULLIF(p_address->>'village', ''),    village),
    landmark   = COALESCE(NULLIF(p_address->>'landmark', ''),   landmark),
    residence_lat = COALESCE(p_latitude,  residence_lat),
    residence_lng = COALESCE(p_longitude, residence_lng),
    residence_updated_at = CASE WHEN p_latitude IS NOT NULL THEN now() ELSE residence_updated_at END,
    address_complete = true,
    address_completed_at = COALESCE(address_completed_at, now()),
    updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.update_user_location', 'profiles', p_user_id::text,
    jsonb_build_object(
      'reason', p_reason,
      'is_ops', v_is_ops,
      'is_agent_owner', v_is_agent_owner,
      'address', p_address,
      'lat', p_latitude,
      'lng', p_longitude,
      'accuracy', p_accuracy
    )
  );

  INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
  VALUES (
    'ops.user_location_updated', v_actor, p_user_id,
    jsonb_build_object('reason', p_reason, 'lat', p_latitude, 'lng', p_longitude)
  );

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_update_user_location(uuid, jsonb, double precision, double precision, double precision, text) TO authenticated;

-- 4) ops_link_landlord_funder
CREATE OR REPLACE FUNCTION public.ops_link_landlord_funder(
  p_landlord_id uuid,
  p_funder_id   uuid,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_link_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Only ops roles can link funders';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  INSERT INTO public.landlord_funder_links (landlord_id, funder_id, linked_by, reason)
  VALUES (p_landlord_id, p_funder_id, v_actor, p_reason)
  ON CONFLICT (landlord_id, funder_id) WHERE active = true
  DO NOTHING
  RETURNING id INTO v_link_id;

  IF v_link_id IS NULL THEN
    SELECT id INTO v_link_id FROM public.landlord_funder_links
      WHERE landlord_id = p_landlord_id AND funder_id = p_funder_id AND active = true
      LIMIT 1;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.link_landlord_funder', 'landlord_funder_links', v_link_id::text,
    jsonb_build_object('landlord_id', p_landlord_id, 'funder_id', p_funder_id, 'reason', p_reason)
  );

  INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
  VALUES (
    'ops.landlord_funder_linked', v_actor, p_landlord_id,
    jsonb_build_object('funder_id', p_funder_id, 'link_id', v_link_id, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'link_id', v_link_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_link_landlord_funder(uuid, uuid, text) TO authenticated;

-- 5) ops_link_agent_landlord
CREATE OR REPLACE FUNCTION public.ops_link_agent_landlord(
  p_agent_id    uuid,
  p_landlord_id uuid,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_assignment_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Only ops roles can link agents to landlords';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  INSERT INTO public.agent_landlord_assignments (agent_id, landlord_id, status)
  VALUES (p_agent_id, p_landlord_id, 'active')
  ON CONFLICT (agent_id, landlord_id) DO UPDATE
    SET status = 'active'
  RETURNING id INTO v_assignment_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.link_agent_landlord', 'agent_landlord_assignments', v_assignment_id::text,
    jsonb_build_object('agent_id', p_agent_id, 'landlord_id', p_landlord_id, 'reason', p_reason)
  );

  INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
  VALUES (
    'ops.agent_landlord_linked', v_actor, p_landlord_id,
    jsonb_build_object('agent_id', p_agent_id, 'assignment_id', v_assignment_id, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true, 'assignment_id', v_assignment_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_link_agent_landlord(uuid, uuid, text) TO authenticated;
