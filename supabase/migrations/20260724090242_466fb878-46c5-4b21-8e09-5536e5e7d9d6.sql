-- Allow campaign links to represent an entire district entered as free text
ALTER TABLE public.recruitment_campaign_links
  ADD COLUMN IF NOT EXISTS district_name text;

ALTER TABLE public.recruitment_campaign_links
  ALTER COLUMN location_id DROP NOT NULL;

-- Slug helper (idempotent)
CREATE OR REPLACE FUNCTION public.slugify_district(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT trim(both '-' from
    regexp_replace(
      regexp_replace(lower(coalesce(p_input,'')), '[^a-z0-9]+', '-', 'g'),
      '-+', '-', 'g'
    )
  );
$$;

-- District normalizer: title-case each word, collapse whitespace
CREATE OR REPLACE FUNCTION public.normalize_district_name(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT initcap(regexp_replace(trim(coalesce(p_input,'')), '\s+', ' ', 'g'));
$$;

-- New RPC that accepts a free-text district. Different arg types from the
-- existing uuid-based create_campaign_link, so PostgREST can distinguish them.
CREATE OR REPLACE FUNCTION public.create_campaign_link(
  p_campaign_id uuid,
  p_district_name text,
  p_selected_source recruitment_source,
  p_link_type recruitment_link_type DEFAULT 'general_campaign_link',
  p_placement_name text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL
)
RETURNS recruitment_campaign_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid;
  v_is_admin boolean;
  v_status public.recruitment_campaign_status;
  v_name text;
  v_slug text;
  v_code text;
  v_placement text;
  v_row public.recruitment_campaign_links;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;

  -- Validate + normalize district
  v_name := public.normalize_district_name(p_district_name);
  IF v_name IS NULL OR length(v_name) < 2 THEN
    RAISE EXCEPTION 'district must be at least 2 characters';
  END IF;
  IF length(v_name) > 80 THEN
    RAISE EXCEPTION 'district must be 80 characters or fewer';
  END IF;
  IF v_name !~ '[A-Za-z]' THEN
    RAISE EXCEPTION 'district must contain letters';
  END IF;
  v_slug := public.slugify_district(v_name);
  IF v_slug IS NULL OR length(v_slug) < 2 THEN
    RAISE EXCEPTION 'district must be at least 2 characters';
  END IF;

  -- Determine owning agent: CMO/super_admin may pass p_agent_id; everyone else owns their own link
  v_is_admin := public.has_role(v_caller, 'cmo')
             OR public.has_role(v_caller, 'super_admin')
             OR public.has_role(v_caller, 'cto');
  IF p_agent_id IS NOT NULL AND v_is_admin THEN
    v_owner := p_agent_id;
  ELSE
    v_owner := v_caller;
  END IF;

  SELECT status INTO v_status FROM public.recruitment_campaigns WHERE id = p_campaign_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'campaign not found'; END IF;
  IF v_status <> 'active' THEN RAISE EXCEPTION 'campaign not active'; END IF;

  INSERT INTO public.recruitment_campaign_agents(campaign_id, agent_id)
  VALUES (p_campaign_id, v_owner)
  ON CONFLICT DO NOTHING;

  v_code := public.generate_campaign_short_code();
  v_placement := nullif(trim(coalesce(p_placement_name,'')), '');

  INSERT INTO public.recruitment_campaign_links(
    short_code, campaign_id, agent_id, location_id, location_slug,
    district_name, selected_source, link_type, placement_name
  ) VALUES (
    v_code, p_campaign_id, v_owner, NULL, v_slug,
    v_name, p_selected_source, p_link_type, v_placement
  ) RETURNING * INTO v_row;

  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.create_campaign_link(uuid, text, recruitment_source, recruitment_link_type, text, uuid) TO authenticated;