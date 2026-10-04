CREATE TABLE IF NOT EXISTS public.house_support_share_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_code text NOT NULL,
  house_id uuid,
  sharing_user_id uuid,
  visitor_user_id uuid,
  event text NOT NULL,
  commitment_id uuid,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hsse_code ON public.house_support_share_events (share_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hsse_sharer ON public.house_support_share_events (sharing_user_id, event, created_at DESC);

GRANT SELECT ON public.house_support_share_events TO authenticated;
GRANT ALL ON public.house_support_share_events TO service_role;

ALTER TABLE public.house_support_share_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hsse_sharer_reads_own ON public.house_support_share_events;
CREATE POLICY hsse_sharer_reads_own ON public.house_support_share_events
  FOR SELECT TO authenticated
  USING (sharing_user_id = auth.uid() OR visitor_user_id = auth.uid() OR public.is_ops_role(auth.uid()));

CREATE OR REPLACE FUNCTION public.get_or_create_house_share_link(p_house_id uuid)
RETURNS TABLE(code text, og_title text, og_description text, og_image_url text, destination_path text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_row public.short_links;
  v_created boolean := false;
  v_h public.house_listings;
  v_image text;
  v_title text;
  v_desc text;
  v_dest text := '/support-house';
  v_fp text;
  v_place text;
  v_cat text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to share this house';
  END IF;

  SELECT * INTO v_h FROM public.house_listings WHERE id = p_house_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HOUSE_NOT_FOUND';
  END IF;

  v_cat := NULLIF(btrim(initcap(replace(COALESCE(v_h.house_category, ''), '_', ' '))), '');
  v_place := NULLIF(btrim(concat_ws(', ', NULLIF(v_h.village,''), NULLIF(v_h.sub_county,''), NULLIF(v_h.district,''))), '');
  v_title := COALESCE(NULLIF(btrim(v_h.title), ''), COALESCE(v_cat, 'Empty house'))
             || ' in ' || COALESCE(v_place || ', Uganda', 'Uganda') || ' | Welile';
  v_desc := 'Support this available house through Welile. Pay one month''s rent of UGX '
            || to_char(round(COALESCE(v_h.monthly_rent,0)), 'FM999,999,999')
            || ' and receive UGX ' || to_char(round(COALESCE(v_h.monthly_rent,0) * 0.15), 'FM999,999,999')
            || ' every month for the next 12 months. A family moves in as soon as it is supported.';

  SELECT u INTO v_image
  FROM unnest(COALESCE(v_h.image_urls, ARRAY[]::text[])) u
  WHERE u IS NOT NULL AND u <> '' AND u ILIKE 'https://%'
  LIMIT 1;

  v_fp := md5(COALESCE(v_image,'') || '|' || v_title || '|' || v_desc);

  SELECT * INTO v_row FROM public.short_links s
   WHERE s.user_id = v_user AND s.resource_type = 'house_support' AND s.resource_id = p_house_id
   LIMIT 1;

  IF v_row.id IS NULL THEN
    BEGIN
      INSERT INTO public.short_links (
        user_id, target_path, target_params, resource_type, resource_id,
        og_title, og_description, og_image_url, og_image_fingerprint, og_updated_at, destination_path
      ) VALUES (
        v_user, v_dest, '{}'::jsonb, 'house_support', p_house_id,
        v_title, v_desc, v_image, v_fp, now(), v_dest
      ) RETURNING * INTO v_row;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_row FROM public.short_links s
       WHERE s.user_id = v_user AND s.resource_type = 'house_support' AND s.resource_id = p_house_id
       LIMIT 1;
    END;
  END IF;

  IF v_row.id IS NOT NULL AND (COALESCE(v_row.target_params->>'s','') <> v_row.code
      OR COALESCE(v_row.og_image_fingerprint,'') <> v_fp) THEN
    UPDATE public.short_links s
       SET target_params = jsonb_build_object('s', s.code),
           target_path = v_dest,
           destination_path = v_dest,
           og_title = v_title,
           og_description = v_desc,
           og_image_url = v_image,
           og_image_fingerprint = v_fp,
           og_updated_at = now()
     WHERE s.id = v_row.id
     RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT v_row.code, v_row.og_title, v_row.og_description,
                      v_row.og_image_url, COALESCE(v_row.destination_path, v_row.target_path), v_created;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_create_house_share_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_house_share_link(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.public_house_support_offer(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT jsonb_build_object(
    'found', true,
    'share_code', s.code,
    'house_id', h.id,
    'title', COALESCE(NULLIF(btrim(h.title),''), initcap(replace(COALESCE(h.house_category,'Rental home'),'_',' '))),
    'house_category', h.house_category,
    'number_of_rooms', h.number_of_rooms,
    'village', h.village,
    'sub_county', h.sub_county,
    'district', h.district,
    'region', h.region,
    'monthly_rent', COALESCE(h.monthly_rent,0),
    'monthly_return', round(COALESCE(h.monthly_rent,0) * 0.15),
    'image_urls', COALESCE(to_jsonb(h.image_urls), '[]'::jsonb),
    'latitude', h.latitude,
    'longitude', h.longitude,
    'verified', COALESCE(h.verified,false),
    'shared_by', COALESCE(NULLIF(split_part(btrim(p.full_name), ' ', 1), ''), 'A Welile agent'),
    'availability', CASE
      WHEN EXISTS (SELECT 1 FROM public.partner_supported_houses ps
                    WHERE ps.house_id = h.id AND ps.status IN ('pending','active')) THEN 'supported'
      WHEN EXISTS (SELECT 1 FROM public.promissory_note_house_intents i
                    WHERE i.house_id = h.id AND i.status = 'reserved') THEN 'reserved'
      WHEN h.verified IS NOT TRUE OR h.status <> 'available' OR h.tenant_id IS NOT NULL
           OR COALESCE(h.is_hidden,false) = true OR COALESCE(h.monthly_rent,0) <= 0 THEN 'unavailable'
      ELSE 'available'
    END
  ) INTO v
  FROM public.short_links s
  JOIN public.house_listings h ON h.id = s.resource_id
  LEFT JOIN public.profiles p ON p.id = s.user_id
  WHERE s.code = p_code AND s.resource_type = 'house_support'
  LIMIT 1;

  RETURN COALESCE(v, jsonb_build_object('found', false));
END;
$function$;

REVOKE ALL ON FUNCTION public.public_house_support_offer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_house_support_offer(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_house_support_share_event(
  p_code text,
  p_event text,
  p_commitment_id uuid DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_share record;
BEGIN
  IF p_event NOT IN ('opened','visit_location_clicked','support_clicked','auth_started',
                     'signup_completed','support_started','support_completed') THEN
    RETURN;
  END IF;

  SELECT s.code, s.user_id, s.resource_id INTO v_share
  FROM public.short_links s
  WHERE s.code = p_code AND s.resource_type = 'house_support'
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.house_support_share_events (
    share_code, house_id, sharing_user_id, visitor_user_id, event, commitment_id, user_agent
  ) VALUES (
    v_share.code, v_share.resource_id, v_share.user_id, auth.uid(), p_event, p_commitment_id,
    left(COALESCE(p_user_agent,''), 300)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.log_house_support_share_event(text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_house_support_share_event(text, text, uuid, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.house_share_performance()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'opened', COUNT(*) FILTER (WHERE e.event = 'opened'),
    'support_clicked', COUNT(*) FILTER (WHERE e.event = 'support_clicked'),
    'support_completed', COUNT(*) FILTER (WHERE e.event = 'support_completed'),
    'links', (SELECT COUNT(*) FROM public.short_links s
               WHERE s.user_id = auth.uid() AND s.resource_type = 'house_support')
  )
  FROM public.house_support_share_events e
  WHERE e.sharing_user_id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.house_share_performance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.house_share_performance() TO authenticated;