ALTER TABLE public.short_links
  ADD COLUMN IF NOT EXISTS resource_type text,
  ADD COLUMN IF NOT EXISTS resource_id uuid,
  ADD COLUMN IF NOT EXISTS og_title text,
  ADD COLUMN IF NOT EXISTS og_description text,
  ADD COLUMN IF NOT EXISTS og_image_url text,
  ADD COLUMN IF NOT EXISTS og_image_fingerprint text,
  ADD COLUMN IF NOT EXISTS og_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS destination_path text;

-- Backfill resource identity for existing plan links, keeping the OLDEST row per
-- (user, plan) so no existing code is touched and duplicates stay untagged.
WITH ranked AS (
  SELECT id, user_id,
         (target_params->>'plan')::uuid AS plan_id,
         row_number() OVER (PARTITION BY user_id, target_params->>'plan' ORDER BY created_at, id) AS rn
  FROM public.short_links
  WHERE resource_type IS NULL
    AND target_params ? 'plan'
    AND (target_params->>'plan') ~* '^[0-9a-f-]{36}$'
)
UPDATE public.short_links s
SET resource_type = 'rent_plan', resource_id = ranked.plan_id
FROM ranked
WHERE ranked.id = s.id AND ranked.rn = 1;

CREATE UNIQUE INDEX IF NOT EXISTS short_links_resource_owner_uniq
  ON public.short_links (user_id, resource_type, resource_id)
  WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_or_create_plan_share_link(p_plan_id uuid)
RETURNS TABLE (
  code text,
  og_title text,
  og_description text,
  og_image_url text,
  destination_path text,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row public.short_links;
  v_created boolean := false;
  v_rent numeric := 0;
  v_category text;
  v_loc text;
  v_images text[];
  v_image text;
  v_title text;
  v_desc text;
  v_dest text := '/funder-onboarding';
  v_fp text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to share this plan';
  END IF;

  -- Authoritative plan data (never trust client-supplied preview values).
  SELECT COALESCE(p.funding_amount, 0), p.house_category,
         COALESCE(NULLIF(p.tenant_location, ''), p.request_city), p.house_image_urls
    INTO v_rent, v_category, v_loc, v_images
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = p_plan_id;

  IF NOT FOUND THEN
    SELECT COALESCE(r.rent_amount, 0), r.house_category, r.request_city, r.house_image_urls
      INTO v_rent, v_category, v_loc, v_images
    FROM public.rent_requests r
    WHERE r.id = p_plan_id;
  END IF;

  v_category := NULLIF(btrim(initcap(replace(COALESCE(v_category, ''), '_', ' '))), '');
  v_loc := NULLIF(btrim(COALESCE(v_loc, '')), '');
  v_title := 'Support a tenant in a ' || COALESCE(v_category, 'Rental Home')
             || ' in ' || COALESCE(v_loc || ', Uganda', 'Uganda');
  v_desc := CASE WHEN v_rent > 0 THEN
      'Support this tenant for UGX ' || to_char(round(v_rent), 'FM999,999,999')
      || ' by paying their landlord on the platform and earn UGX '
      || to_char(round(v_rent * 0.15), 'FM999,999,999')
      || ' per month for the next 12 months Start here today.'
    ELSE
      'Support a tenant''s rent on Welile and earn monthly returns. Support today.'
    END;

  SELECT u INTO v_image
  FROM unnest(COALESCE(v_images, ARRAY[]::text[])) u
  WHERE u IS NOT NULL AND u <> '' AND u ILIKE 'https://%'
  LIMIT 1;

  v_fp := md5(COALESCE(v_image, '') || '|' || COALESCE(v_title, '') || '|' || COALESCE(v_desc, ''));

  SELECT * INTO v_row FROM public.short_links s
  WHERE s.user_id = v_user AND s.resource_type = 'rent_plan' AND s.resource_id = p_plan_id
  LIMIT 1;

  IF NOT FOUND THEN
    -- Legacy row for the same sharer/plan created before resource tagging.
    SELECT * INTO v_row FROM public.short_links s
    WHERE s.user_id = v_user
      AND s.resource_type IS NULL
      AND s.target_params->>'plan' = p_plan_id::text
    ORDER BY s.created_at
    LIMIT 1;
  END IF;

  IF v_row.id IS NULL THEN
    BEGIN
      INSERT INTO public.short_links (
        user_id, target_path, target_params, resource_type, resource_id,
        og_title, og_description, og_image_url, og_image_fingerprint, og_updated_at, destination_path
      ) VALUES (
        v_user, v_dest,
        jsonb_build_object('plan', p_plan_id::text, 'ref', v_user::text),
        'rent_plan', p_plan_id,
        v_title, v_desc, v_image, v_fp, now(), v_dest
      )
      RETURNING * INTO v_row;
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent tap inserted first: return that persisted row.
      SELECT * INTO v_row FROM public.short_links s
      WHERE s.user_id = v_user AND s.resource_type = 'rent_plan' AND s.resource_id = p_plan_id
      LIMIT 1;
    END;
  END IF;

  -- Refresh metadata in place only when it actually changed. The id, code and
  -- attribution are never modified.
  IF NOT v_created AND v_row.id IS NOT NULL
     AND COALESCE(v_row.og_image_fingerprint, '') <> v_fp THEN
    UPDATE public.short_links s
    SET resource_type = 'rent_plan',
        resource_id = p_plan_id,
        og_title = v_title,
        og_description = v_desc,
        og_image_url = v_image,
        og_image_fingerprint = v_fp,
        og_updated_at = now(),
        destination_path = COALESCE(s.destination_path, v_dest)
    WHERE s.id = v_row.id
    RETURNING * INTO v_row;
  END IF;

  RETURN QUERY SELECT v_row.code, v_row.og_title, v_row.og_description,
                      v_row.og_image_url, COALESCE(v_row.destination_path, v_row.target_path), v_created;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_plan_share_link(uuid) TO authenticated;