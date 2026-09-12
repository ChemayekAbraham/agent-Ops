-- One-click mapping of unmatched (legacy) district spellings to an approved
-- Uganda district. Nothing in house_listings / landlords / profiles is ever
-- rewritten: the recorded spelling stays exactly as captured and only an alias
-- override row is added, which the read-only float geo functions consult.

CREATE TABLE IF NOT EXISTS public.ug_district_alias_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  norm_key text NOT NULL UNIQUE,
  recorded_text text NOT NULL,
  district_id integer NOT NULL REFERENCES public.ug_districts(id),
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ug_district_alias_overrides TO authenticated;
GRANT ALL ON public.ug_district_alias_overrides TO service_role;

ALTER TABLE public.ug_district_alias_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops can read district alias overrides" ON public.ug_district_alias_overrides;
CREATE POLICY "Ops can read district alias overrides"
ON public.ug_district_alias_overrides
FOR SELECT
TO authenticated
USING (public.is_ops_role(auth.uid()));

-- Canonical alias resolution: approved districts first, then operator-supplied
-- overrides for spellings the approved list does not contain.
CREATE OR REPLACE VIEW public.v_ug_district_alias_all AS
SELECT m.norm_key, m.district_id, m.district_name, m.region
FROM public.mv_ug_district_alias m
UNION ALL
SELECT o.norm_key, d.id AS district_id, d.name AS district_name, d.region
FROM public.ug_district_alias_overrides o
JOIN public.ug_districts d ON d.id = o.district_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.mv_ug_district_alias m2 WHERE m2.norm_key = o.norm_key
);

GRANT SELECT ON public.v_ug_district_alias_all TO authenticated;
GRANT SELECT ON public.v_ug_district_alias_all TO service_role;

-- Approved districts for the mapping picker (read-only).
CREATE OR REPLACE FUNCTION public.landlord_ops_approved_districts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.is_ops_role(v_uid) THEN
    RAISE EXCEPTION 'Not authorised to read approved districts';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'region', d.region)
                            ORDER BY d.region, d.name), '[]'::jsonb)
  INTO v_rows
  FROM ug_districts d;

  RETURN jsonb_build_object('rows', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_approved_districts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_ops_approved_districts() TO authenticated;

-- One-click mapping action. Records an alias only; never touches the recorded
-- location text on any tenant, landlord or house record.
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

  IF EXISTS (SELECT 1 FROM mv_ug_district_alias WHERE norm_key = v_norm) THEN
    RAISE EXCEPTION 'That spelling already matches an approved district';
  END IF;

  INSERT INTO ug_district_alias_overrides (norm_key, recorded_text, district_id, reason, created_by)
  VALUES (v_norm, TRIM(p_recorded_text), p_district_id, TRIM(p_reason), v_uid)
  ON CONFLICT (norm_key) DO UPDATE
    SET district_id = EXCLUDED.district_id,
        recorded_text = EXCLUDED.recorded_text,
        reason = EXCLUDED.reason,
        created_by = EXCLUDED.created_by,
        updated_at = now()
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
