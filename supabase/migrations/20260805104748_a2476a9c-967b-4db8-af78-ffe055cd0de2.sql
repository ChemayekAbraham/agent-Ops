DROP FUNCTION IF EXISTS public.ops_lc1_verification_report(text, timestamptz, timestamptz, text, integer);

CREATE OR REPLACE VIEW public.v_lc1_verification_inbox AS
SELECT c.id AS lc1_id,
    r.id AS request_id,
    c.name AS lc1_name,
    c.phone AS lc1_phone,
    c.village AS lc1_village,
    c.district AS lc1_district,
    c.region AS lc1_region,
    c.parish AS lc1_parish,
    c.sub_county AS lc1_sub_county,
    COALESCE(c.verification_status, 'pending'::text) AS status,
    c.verification_reason AS reason,
    c.verified AS verified_flag,
    c.verified_at,
    c.verified_by,
    vp.full_name AS reviewer_name,
    c.registered_by AS agent_id,
    COALESCE(r.agent_name, ap.full_name) AS agent_name,
    COALESCE(r.agent_phone, ap.phone) AS agent_phone,
    r.note AS agent_note,
    r.reject_comment,
    r.status AS request_status,
    r.resolved_at,
    rp.full_name AS resolved_by_name,
    CASE WHEN r.id IS NOT NULL THEN 'agent_request'::text ELSE 'registration'::text END AS source,
    COALESCE(r.created_at, c.registered_at, c.created_at) AS requested_at,
    c.created_at AS lc1_created_at,
    c.verification_bonus_paid,
    ( SELECT count(*) FROM landlords l WHERE l.phone IS NOT NULL AND l.phone = c.phone) AS linked_landlords,
    (r.id IS NOT NULL AND COALESCE(r.status, 'pending') = 'pending') AS agent_request_open,
    COALESCE(rr.open_count, 0) AS open_rent_requests,
    COALESCE(rr.open_count, 0) > 0 AS has_open_rent_request
   FROM lc1_chairpersons c
     LEFT JOIN LATERAL ( SELECT r2.id, r2.agent_name, r2.agent_phone, r2.note, r2.status,
            r2.reject_comment, r2.resolved_by, r2.resolved_at, r2.created_at
           FROM lc1_verification_requests r2
          WHERE r2.lc1_id = c.id
          ORDER BY (COALESCE(r2.resolved_at, r2.created_at)) DESC
         LIMIT 1) r ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS open_count
           FROM rent_requests x
          WHERE x.lc1_id = c.id
            AND x.status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
         ) rr ON true
     LEFT JOIN profiles ap ON ap.id = c.registered_by
     LEFT JOIN profiles vp ON vp.id = c.verified_by
     LEFT JOIN profiles rp ON rp.id = r.resolved_by;

CREATE OR REPLACE FUNCTION public.ops_lc1_verification_report(
  p_status text DEFAULT 'verified'::text,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 3000)
 RETURNS SETOF public.v_lc1_verification_inbox
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  RETURN QUERY
  SELECT * FROM public.v_lc1_verification_inbox v
  WHERE (
      p_status IS NULL OR p_status = 'all'
      OR (p_status = 'agent_requested' AND v.agent_request_open AND v.status = 'pending')
      OR (p_status = 'rent_linked' AND v.has_open_rent_request AND v.status = 'pending')
      OR (p_status NOT IN ('agent_requested','rent_linked') AND v.status = p_status)
    )
    AND (p_from IS NULL OR COALESCE(v.verified_at, v.resolved_at, v.requested_at) >= p_from)
    AND (p_to IS NULL OR COALESCE(v.verified_at, v.resolved_at, v.requested_at) <= p_to)
    AND (
      v_search IS NULL
      OR v.lc1_name ILIKE '%' || v_search || '%'
      OR v.lc1_phone ILIKE '%' || v_search || '%'
      OR v.lc1_village ILIKE '%' || v_search || '%'
      OR v.lc1_district ILIKE '%' || v_search || '%'
      OR v.agent_name ILIKE '%' || v_search || '%'
    )
  ORDER BY COALESCE(v.verified_at, v.resolved_at, v.requested_at) DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 3000), 20000));
END;
$function$;

GRANT SELECT ON public.v_lc1_verification_inbox TO authenticated;
GRANT ALL ON public.v_lc1_verification_inbox TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_lc1_verification_report(text, timestamptz, timestamptz, text, integer) TO authenticated;