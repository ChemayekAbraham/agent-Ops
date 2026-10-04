DROP FUNCTION IF EXISTS public.ops_house_listing_report(text, text, timestamptz, timestamptz, text, integer);

CREATE OR REPLACE FUNCTION public.ops_house_listing_report(
  p_status    text        DEFAULT 'pending',
  p_search    text        DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL,
  p_quick     text        DEFAULT 'all',
  p_limit     integer     DEFAULT 3000
)
RETURNS TABLE(row_data jsonb, total_count bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_limit int := least(greatest(coalesce(p_limit, 3000), 1), 10000);
  v_quick text := lower(coalesce(p_quick, 'all'));
  v_status text := lower(coalesce(p_status, 'pending'));
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_like := CASE WHEN v_q IS NULL THEN NULL ELSE '%' || v_q || '%' END;

  RETURN QUERY
  WITH matched AS (
    SELECT
      hl.id, hl.title, hl.house_category, hl.monthly_rent, hl.daily_rate, hl.number_of_rooms,
      hl.address, hl.district, hl.village, hl.region, hl.latitude, hl.longitude,
      coalesce(array_length(hl.image_urls, 1), 0) AS photo_count,
      hl.lc1_chairperson_name, hl.lc1_chairperson_phone, hl.lc1_chairperson_village,
      hl.verified, hl.verified_at, hl.status, hl.is_hidden, hl.created_at, hl.updated_at,
      hl.listing_bonus_paid, hl.listing_bonus_paid_at,
      hl.tenant_id,
      CASE
        WHEN hl.status = 'rejected' THEN coalesce(rj.rejected_at, hl.updated_at, hl.created_at)
        WHEN coalesce(hl.verified, false) THEN coalesce(hl.verified_at, hl.updated_at, hl.created_at)
        ELSE hl.created_at
      END AS activity_at,
      rj.rejection_reason, rj.rejected_at,
      rb.full_name AS rejected_by_name,
      vb.full_name AS verified_by_name,
      ap.full_name AS agent_name, ap.phone AS agent_phone, ap.email AS agent_email,
      tp.full_name AS tenant_name, tp.phone AS tenant_phone,
      ll.name AS landlord_name, ll.phone AS landlord_phone, ll.verified AS landlord_verified,
      ll.verification_status AS landlord_verification_status,
      ll.mobile_money_name, ll.mobile_money_number, ll.bank_name, ll.account_number,
      ll.village AS landlord_village, ll.district AS landlord_district, ll.region AS landlord_region
    FROM public.house_listings hl
    LEFT JOIN public.landlords ll ON ll.id = hl.landlord_id
    LEFT JOIN public.profiles  ap ON ap.id = hl.agent_id
    LEFT JOIN public.profiles  tp ON tp.id = hl.tenant_id
    LEFT JOIN public.v_house_listing_latest_rejection rj ON rj.listing_id = hl.id
    LEFT JOIN public.profiles  rb ON rb.id = rj.rejected_by
    LEFT JOIN public.profiles  vb ON vb.id = hl.verified_by
    WHERE
      CASE v_status
        WHEN 'pending'  THEN coalesce(hl.verified, false) = false AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'hidden'   THEN coalesce(hl.verified, false) = true  AND coalesce(hl.is_hidden, false) = true AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'verified' THEN coalesce(hl.verified, false) = true  AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'rejected' THEN hl.status = 'rejected'
        ELSE coalesce(hl.status,'') NOT IN ('delisted')
      END
      AND CASE v_quick
        WHEN 'has_landlord' THEN hl.landlord_id IS NOT NULL
        WHEN 'no_landlord'  THEN hl.landlord_id IS NULL
        WHEN 'has_images'   THEN coalesce(array_length(hl.image_urls, 1), 0) > 0
        WHEN 'has_gps'      THEN hl.latitude IS NOT NULL AND hl.longitude IS NOT NULL
        WHEN 'has_lc1'      THEN nullif(btrim(coalesce(hl.lc1_chairperson_name,'')),'') IS NOT NULL
        WHEN 'hidden'       THEN coalesce(hl.is_hidden, false) = true
        WHEN 'visible'      THEN coalesce(hl.is_hidden, false) = false
        ELSE true
      END
      AND (
        p_date_from IS NULL OR
        (CASE
          WHEN hl.status = 'rejected' THEN coalesce(rj.rejected_at, hl.updated_at, hl.created_at)
          WHEN coalesce(hl.verified, false) THEN coalesce(hl.verified_at, hl.updated_at, hl.created_at)
          ELSE hl.created_at
        END) >= p_date_from
      )
      AND (
        p_date_to IS NULL OR
        (CASE
          WHEN hl.status = 'rejected' THEN coalesce(rj.rejected_at, hl.updated_at, hl.created_at)
          WHEN coalesce(hl.verified, false) THEN coalesce(hl.verified_at, hl.updated_at, hl.created_at)
          ELSE hl.created_at
        END) <= p_date_to
      )
      AND (
        v_like IS NULL
        OR hl.title ILIKE v_like
        OR hl.district ILIKE v_like
        OR hl.village ILIKE v_like
        OR hl.region ILIKE v_like
        OR hl.address ILIKE v_like
        OR hl.lc1_chairperson_name ILIKE v_like
        OR hl.lc1_chairperson_phone ILIKE v_like
        OR ll.name ILIKE v_like
        OR ll.phone ILIKE v_like
        OR ap.full_name ILIKE v_like
        OR ap.phone ILIKE v_like
        OR ap.email ILIKE v_like
        OR tp.full_name ILIKE v_like
        OR tp.phone ILIKE v_like
      )
  ), counted AS (SELECT count(*)::bigint AS n FROM matched)
  SELECT to_jsonb(m) AS row_data, c.n
  FROM matched m CROSS JOIN counted c
  ORDER BY m.activity_at DESC
  LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_house_listing_report(text, text, timestamptz, timestamptz, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_house_listing_report(text, text, timestamptz, timestamptz, text, integer) TO authenticated;
