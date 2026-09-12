-- Read-only status of a recorded spelling: whether it already resolves to an
-- approved district, or already carries an operator override.
CREATE OR REPLACE FUNCTION public.landlord_ops_district_alias_status(p_recorded_text text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_norm text;
  v_approved record;
  v_override record;
BEGIN
  IF v_uid IS NULL OR NOT public.is_ops_role(v_uid) THEN
    RAISE EXCEPTION 'Not authorised to read district mapping status';
  END IF;

  v_norm := ug_norm_name(NULLIF(TRIM(p_recorded_text), ''));
  IF v_norm IS NULL THEN
    RETURN jsonb_build_object('normalisable', false);
  END IF;

  SELECT district_id, district_name, region INTO v_approved
  FROM mv_ug_district_alias WHERE norm_key = v_norm;

  SELECT o.district_id, d.name AS district_name, d.region, o.reason, o.created_at, o.updated_at
  INTO v_override
  FROM ug_district_alias_overrides o
  JOIN ug_districts d ON d.id = o.district_id
  WHERE o.norm_key = v_norm;

  RETURN jsonb_build_object(
    'normalisable', true,
    'norm_key', v_norm,
    'approved', CASE WHEN v_approved.district_id IS NULL THEN NULL ELSE jsonb_build_object(
      'district_id', v_approved.district_id,
      'district_name', v_approved.district_name,
      'region', v_approved.region) END,
    'override', CASE WHEN v_override.district_id IS NULL THEN NULL ELSE jsonb_build_object(
      'district_id', v_override.district_id,
      'district_name', v_override.district_name,
      'region', v_override.region,
      'reason', v_override.reason,
      'mapped_at', COALESCE(v_override.updated_at, v_override.created_at)) END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_district_alias_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_district_alias_status(text) TO authenticated;

-- Mapping action: now refuses outright when an override already exists for the
-- spelling, naming the district and region it currently points at. No silent
-- overwrite of an earlier operator decision.
CREATE OR REPLACE FUNCTION public.landlord_ops_map_district_alias(
  p_recorded_text text,
  p_district_id integer,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_norm text;
  v_district record;
  v_existing record;
  v_id uuid;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       public.is_ops_role(v_uid)
       OR has_role(v_uid,'landlord_ops') OR has_role(v_uid,'operations')
       OR has_role(v_uid,'coo') OR has_role(v_uid,'ceo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'super_admin')
     ) THEN
    RAISE EXCEPTION 'Not authorised to map district spellings';
  END IF;

  IF COALESCE(TRIM(p_recorded_text),'') = '' THEN
    RAISE EXCEPTION 'The recorded location text is required';
  END IF;

  IF COALESCE(LENGTH(TRIM(p_reason)),0) < 10 THEN
    RAISE EXCEPTION 'A written reason of at least 10 characters is required';
  END IF;

  v_norm := ug_norm_name(TRIM(p_recorded_text));
  IF v_norm IS NULL THEN
    RAISE EXCEPTION 'The recorded location text cannot be normalised';
  END IF;

  SELECT id, name, region INTO v_district FROM ug_districts WHERE id = p_district_id;
  IF v_district.id IS NULL THEN
    RAISE EXCEPTION 'That approved district does not exist';
  END IF;

  SELECT m.district_name, m.region INTO v_existing
  FROM mv_ug_district_alias m WHERE m.norm_key = v_norm;
  IF v_existing.district_name IS NOT NULL THEN
    RAISE EXCEPTION 'That spelling already matches the approved district % (%). No mapping is needed.',
      v_existing.district_name, COALESCE(v_existing.region, 'region not recorded');
  END IF;

  SELECT d.name AS district_name, d.region INTO v_existing
  FROM ug_district_alias_overrides o
  JOIN ug_districts d ON d.id = o.district_id
  WHERE o.norm_key = v_norm;
  IF v_existing.district_name IS NOT NULL THEN
    RAISE EXCEPTION 'That spelling is already mapped to % (%). Remove or change that mapping first instead of adding a conflicting one.',
      v_existing.district_name, COALESCE(v_existing.region, 'region not recorded');
  END IF;

  INSERT INTO ug_district_alias_overrides (norm_key, recorded_text, district_id, reason, created_by)
  VALUES (v_norm, TRIM(p_recorded_text), p_district_id, TRIM(p_reason), v_uid)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES ('district_alias_mapped', 'ug_district_alias_overrides', v_id, v_uid, TRIM(p_reason),
          jsonb_build_object('recorded_text', TRIM(p_recorded_text), 'norm_key', v_norm,
                             'district_id', v_district.id, 'district_name', v_district.name,
                             'region', v_district.region));

  RETURN jsonb_build_object(
    'id', v_id,
    'recorded_text', TRIM(p_recorded_text),
    'district_name', v_district.name,
    'region', v_district.region
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_map_district_alias(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_map_district_alias(text, integer, text) TO authenticated;
