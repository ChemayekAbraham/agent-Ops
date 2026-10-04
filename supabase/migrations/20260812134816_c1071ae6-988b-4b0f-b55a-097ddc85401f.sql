CREATE OR REPLACE FUNCTION public.ops_house_listing_report(p_status text DEFAULT 'pending'::text, p_search text DEFAULT NULL::text, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_quick text DEFAULT 'all'::text, p_limit integer DEFAULT 3000)
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
      nullif(btrim(coalesce(hl.service_center_comment, '')), '') AS service_center_comment,
      rc.review_comment,
      rc.review_comment_at,
      rc.review_comment_by_name,
      rc.review_comment_action,
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
    LEFT JOIN LATERAL (
      SELECT
        nullif(btrim(al.metadata->>'reason'), '') AS review_comment,
        al.created_at                             AS review_comment_at,
        rp.full_name                              AS review_comment_by_name,
        al.action_type                            AS review_comment_action
      FROM public.audit_logs al
      LEFT JOIN public.profiles rp ON rp.id = al.user_id
      WHERE al.table_name = 'house_listings'
        AND al.record_id = hl.id::text
        AND al.action_type IN ('listing_verified', 'listing_rejected')
        AND nullif(btrim(al.metadata->>'reason'), '') IS NOT NULL
      ORDER BY al.created_at DESC
      LIMIT 1
    ) rc ON true
    WHERE coalesce(hl.service_center_status, 'not_required') IN ('not_required', 'passed') AND 
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

CREATE OR REPLACE FUNCTION public.ops_landlord_report(p_status text DEFAULT 'all'::text, p_search text DEFAULT NULL::text, p_quick text DEFAULT 'all'::text, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 10000)
 RETURNS TABLE(row_data jsonb, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT
      l.*,
      v.status AS v_status,
      v.source AS v_source,
      v.tenant_count AS tc_count,
      v.has_tenant,
      CASE WHEN v.status = 'pending' THEN l.created_at
           ELSE COALESCE(l.verification_updated_at, l.created_at) END AS activity_at
    FROM public.landlords l
    JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
  ),
  filtered AS (
    SELECT b.* FROM base b
    WHERE (
        COALESCE(p_status, 'all') = 'all'
        OR (p_status = 'has_tenants' AND b.has_tenant)
        OR (p_status = 'no_tenants'  AND NOT b.has_tenant)
        OR b.v_status = p_status
      )
      AND (
        COALESCE(p_quick, 'all') = 'all'
        OR (p_quick = 'has_address'    AND b.property_address IS NOT NULL AND btrim(b.property_address) <> '')
        OR (p_quick = 'has_phone'      AND b.phone IS NOT NULL AND length(b.phone) >= 9)
        OR (p_quick = 'has_smartphone' AND b.has_smartphone IS TRUE)
        OR (p_quick = 'has_bank'       AND b.bank_name IS NOT NULL AND b.account_number IS NOT NULL)
        OR (p_quick = 'has_momo'       AND b.mobile_money_number IS NOT NULL)
      )
      AND (
        NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL
        OR lower(COALESCE(b.name, ''))             LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.phone, ''))            LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.district, ''))         LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.region, ''))           LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.village, ''))          LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(b.property_address, '')) LIKE '%' || lower(btrim(p_search)) || '%'
      )
      AND (p_date_from IS NULL OR b.activity_at >= p_date_from)
      AND (p_date_to   IS NULL OR b.activity_at <= p_date_to)
  ),
  counted AS (SELECT f.*, count(*) OVER () AS tm FROM filtered f)
  SELECT
    jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'phone', c.phone,
      'status', c.v_status,
      'source', c.v_source,
      'verification_reason', c.verification_reason,
      'service_center_comment', NULLIF(btrim(COALESCE(c.service_center_comment, '')), ''),
      'verification_updated_at', c.verification_updated_at,
      'verified_by_name', pv.full_name,
      'created_at', c.created_at,
      'activity_at', c.activity_at,
      'village', c.village,
      'district', c.district,
      'region', c.region,
      'property_address', c.property_address,
      'monthly_rent', c.monthly_rent,
      'number_of_houses', c.number_of_houses,
      'number_of_rooms', c.number_of_rooms,
      'house_category', c.house_category,
      'has_smartphone', c.has_smartphone,
      'mobile_money_name', c.mobile_money_name,
      'mobile_money_number', c.mobile_money_number,
      'bank_name', c.bank_name,
      'account_number', c.account_number,
      'caretaker_name', c.caretaker_name,
      'caretaker_phone', c.caretaker_phone,
      'tin', c.tin,
      'tenant_count', c.tc_count,
      'has_tenant', c.has_tenant,
      'agent_name', COALESCE(pa_mgr.full_name, pa_reg.full_name),
      'agent_phone', COALESCE(pa_mgr.phone, pa_reg.phone),
      'tenant_name', pt.full_name,
      'tenant_phone', pt.phone
    ) AS row_data,
    c.tm AS total_count
  FROM counted c
  LEFT JOIN public.profiles pa_mgr ON pa_mgr.id = c.managed_by_agent_id
  LEFT JOIN public.profiles pa_reg ON pa_reg.id = c.registered_by
  LEFT JOIN public.profiles pt     ON pt.id     = c.tenant_id
  LEFT JOIN public.profiles pv     ON pv.id     = c.verified_by
  ORDER BY c.activity_at DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10000), 1), 20000);
$function$;