ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS location_source text;

CREATE OR REPLACE FUNCTION public.set_my_operating_location(
  p_district_id integer,
  p_district text,
  p_village text,
  p_village_id integer DEFAULT NULL,
  p_source text DEFAULT 'dataset'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_region text;
  v_subcounty text;
  v_parish text;
  v_district text := nullif(btrim(p_district), '');
  v_village text := nullif(btrim(p_village), '');
  v_source text := CASE WHEN p_source = 'custom' THEN 'custom' ELSE 'dataset' END;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_village IS NULL THEN
    RAISE EXCEPTION 'Village or area is required';
  END IF;

  IF p_district_id IS NOT NULL THEN
    SELECT d.name, d.region INTO v_district, v_region
    FROM public.ug_districts d WHERE d.id = p_district_id;
  END IF;

  IF v_district IS NULL THEN
    RAISE EXCEPTION 'District is required';
  END IF;

  IF v_source = 'dataset' AND p_village_id IS NOT NULL THEN
    SELECT sc.name, pa.name INTO v_subcounty, v_parish
    FROM public.ug_villages vg
    JOIN public.ug_parishes pa ON pa.id = vg.parish_id
    JOIN public.ug_subcounties sc ON sc.id = pa.subcounty_id
    WHERE vg.id = p_village_id;
  END IF;

  UPDATE public.profiles p
  SET district = v_district,
      region = COALESCE(v_region, p.region),
      village = v_village,
      sub_county = COALESCE(v_subcounty, p.sub_county),
      parish = COALESCE(v_parish, p.parish),
      ug_village_id = CASE WHEN v_source = 'dataset' THEN p_village_id ELSE NULL END,
      location_source = v_source,
      updated_at = now()
  WHERE p.id = v_uid;

  RETURN jsonb_build_object(
    'district', v_district,
    'region', v_region,
    'village', v_village,
    'sub_county', v_subcounty,
    'parish', v_parish,
    'ug_village_id', CASE WHEN v_source = 'dataset' THEN p_village_id ELSE NULL END,
    'location_source', v_source
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_operating_location(integer, text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_operating_location(integer, text, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_operating_location(integer, text, text, integer, text) TO service_role;