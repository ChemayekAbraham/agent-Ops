ALTER TABLE public.managed_locations
  ADD COLUMN IF NOT EXISTS ug_district_id integer REFERENCES public.ug_districts(id),
  ADD COLUMN IF NOT EXISTS ug_subcounty_id integer REFERENCES public.ug_subcounties(id),
  ADD COLUMN IF NOT EXISTS ug_parish_id integer REFERENCES public.ug_parishes(id),
  ADD COLUMN IF NOT EXISTS ug_village_id integer REFERENCES public.ug_villages(id);

ALTER TABLE public.recruitment_locations
  ADD COLUMN IF NOT EXISTS ug_district_id integer REFERENCES public.ug_districts(id);

ALTER TABLE public.service_center_requests
  ADD COLUMN IF NOT EXISTS ug_district_id integer REFERENCES public.ug_districts(id);

CREATE INDEX IF NOT EXISTS idx_managed_locations_ug_district ON public.managed_locations(ug_district_id);
CREATE INDEX IF NOT EXISTS idx_recruitment_locations_ug_district ON public.recruitment_locations(ug_district_id);

GRANT SELECT, INSERT, UPDATE ON public.recruitment_locations TO authenticated;

CREATE OR REPLACE FUNCTION public.prevent_duplicate_location_gps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  clash_name TEXT;
BEGIN
  IF NEW.active IS NOT TRUE OR NEW.latitude IS NULL OR NEW.longitude IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT name INTO clash_name
  FROM public.managed_locations m
  WHERE m.id <> NEW.id
    AND m.active IS TRUE
    AND m.latitude IS NOT NULL
    AND m.longitude IS NOT NULL
    -- same administrative area: prefer the official district id, fall back to text
    AND (
      CASE
        WHEN NEW.ug_district_id IS NOT NULL AND m.ug_district_id IS NOT NULL
          THEN m.ug_district_id = NEW.ug_district_id
        ELSE lower(coalesce(trim(m.district), '')) = lower(coalesce(trim(NEW.district), ''))
             AND lower(coalesce(trim(m.region), '')) = lower(coalesce(trim(NEW.region), ''))
      END
    )
    AND round(m.latitude::numeric, 5)  = round(NEW.latitude::numeric, 5)
    AND round(m.longitude::numeric, 5) = round(NEW.longitude::numeric, 5)
  LIMIT 1;

  IF clash_name IS NOT NULL THEN
    RAISE EXCEPTION 'These GPS coordinates are already used by "%" in this administrative area (% / %). Each location in the same area must have unique coordinates.',
      clash_name,
      coalesce(NULLIF(trim(NEW.district), ''), 'no district'),
      coalesce(NULLIF(trim(NEW.region), ''), 'no region')
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_duplicate_location_gps ON public.managed_locations;
CREATE TRIGGER trg_prevent_duplicate_location_gps
BEFORE INSERT OR UPDATE OF latitude, longitude, district, region, active, ug_district_id
ON public.managed_locations
FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_location_gps();

DROP FUNCTION IF EXISTS public.submit_service_center_request(text, text, text, text, text, text, boolean, text);

CREATE OR REPLACE FUNCTION public.submit_service_center_request(
  p_agent_name text,
  p_agent_phone text,
  p_agent_location text,
  p_district text,
  p_preferred_location text,
  p_reason text,
  p_ready boolean,
  p_supporting_note text DEFAULT NULL::text,
  p_ug_district_id integer DEFAULT NULL::integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    agent_id, agent_name, agent_phone, agent_location, district, ug_district_id,
    preferred_location, reason, ready_to_operate, supporting_note,
    qualifying_sub_agents_at_submission, personal_active_tenants_at_submission,
    network_active_tenants_at_submission, qualified_at)
  VALUES (
    v_agent, p_agent_name, p_agent_phone, p_agent_location, p_district, p_ug_district_id,
    trim(p_preferred_location), trim(p_reason), true, p_supporting_note,
    (v_q->>'qualifying_sub_agents')::int, (v_q->>'main_agent_active_tenants')::int,
    (v_q->>'network_active_tenants')::int,
    (SELECT qualified_at FROM public.service_center_qualifications WHERE agent_id = v_agent))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status','pending_review','request_id', v_id);
END; $function$;