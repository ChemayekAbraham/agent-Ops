-- ============================================================
-- Landlord Ops house stats: state-aware activity date + hidden folded into verified
-- ============================================================
-- Root cause of "verified shows 0 for today": every RPC filtered the date range
-- on house_listings.created_at, so a house registered in June and verified today
-- fell outside a "today" window. We introduce a single canonical concept:
--   activity_at = the timestamp the row entered its CURRENT state
--     rejected -> agent_listing_rejections.rejected_at (fallback updated_at/created_at)
--     verified -> house_listings.verified_at            (fallback updated_at/created_at)
--     pending  -> house_listings.created_at
-- All three ops RPCs use it, so chips, list, quick counts and reports agree.

-- Helper view: latest rejection per listing (reason / by / at)
CREATE OR REPLACE VIEW public.v_house_listing_latest_rejection
WITH (security_invoker = on) AS
SELECT DISTINCT ON (r.listing_id)
  r.listing_id,
  r.reason      AS rejection_reason,
  r.rejected_by AS rejected_by,
  r.rejected_at AS rejected_at
FROM public.agent_listing_rejections r
ORDER BY r.listing_id, r.rejected_at DESC NULLS LAST;

-- ── 1. Status counts ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.ops_house_listing_status_counts(text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.ops_house_listing_status_counts(
  p_search    text        DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(pending bigint, verified bigint, hidden bigint, rejected bigint, all_houses bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
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
      coalesce(hl.verified, false)               AS is_verified,
      coalesce(hl.is_hidden, false)              AS is_hidden,
      coalesce(hl.status, '')                    AS status,
      CASE
        WHEN hl.status = 'rejected'
          THEN coalesce(rj.rejected_at, hl.updated_at, hl.created_at)
        WHEN coalesce(hl.verified, false)
          THEN coalesce(hl.verified_at, hl.updated_at, hl.created_at)
        ELSE hl.created_at
      END                                        AS activity_at
    FROM public.house_listings hl
    LEFT JOIN public.landlords ll ON ll.id = hl.landlord_id
    LEFT JOIN public.profiles  ap ON ap.id = hl.agent_id
    LEFT JOIN public.profiles  tp ON tp.id = hl.tenant_id
    LEFT JOIN public.v_house_listing_latest_rejection rj ON rj.listing_id = hl.id
    WHERE (
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
  ), scoped AS (
    SELECT *,
      (p_date_from IS NULL OR activity_at >= p_date_from)
      AND (p_date_to IS NULL OR activity_at <= p_date_to) AS in_range
    FROM matched
  )
  SELECT
    count(*) FILTER (WHERE in_range AND is_verified = false AND status NOT IN ('rejected','delisted'))::bigint,
    count(*) FILTER (WHERE in_range AND is_verified = true  AND status NOT IN ('rejected','delisted'))::bigint,
    -- informational only: hidden is now a SUBSET of verified, not a sibling bucket
    count(*) FILTER (WHERE in_range AND is_hidden AND is_verified = true AND status NOT IN ('rejected','delisted'))::bigint,
    count(*) FILTER (WHERE in_range AND status = 'rejected')::bigint,
    count(*) FILTER (WHERE in_range AND (status = 'rejected' OR status NOT IN ('rejected','delisted')))::bigint
  FROM scoped;
END;
$function$;

-- ── 2. Quick-filter counts (adds hidden/visible within scope) ─
DROP FUNCTION IF EXISTS public.ops_house_quick_filter_counts(text, text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.ops_house_quick_filter_counts(
  p_status    text        DEFAULT 'pending',
  p_search    text        DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL
)
RETURNS TABLE(
  all_scope bigint, has_landlord bigint, no_landlord bigint,
  has_images bigint, has_gps bigint, has_lc1 bigint,
  hidden_scope bigint, visible_scope bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
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
      hl.landlord_id, hl.image_urls, hl.latitude, hl.longitude,
      hl.lc1_chairperson_name, coalesce(hl.is_hidden, false) AS is_hidden
    FROM public.house_listings hl
    LEFT JOIN public.landlords ll ON ll.id = hl.landlord_id
    LEFT JOIN public.profiles  ap ON ap.id = hl.agent_id
    LEFT JOIN public.profiles  tp ON tp.id = hl.tenant_id
    LEFT JOIN public.v_house_listing_latest_rejection rj ON rj.listing_id = hl.id
    WHERE
      CASE v_status
        WHEN 'pending'  THEN coalesce(hl.verified, false) = false AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        -- legacy 'hidden' scope kept for backward compat: hidden lives inside verified now
        WHEN 'hidden'   THEN coalesce(hl.verified, false) = true  AND coalesce(hl.is_hidden, false) = true AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'verified' THEN coalesce(hl.verified, false) = true  AND coalesce(hl.status,'') NOT IN ('rejected','delisted')
        WHEN 'rejected' THEN hl.status = 'rejected'
        ELSE coalesce(hl.status,'') NOT IN ('delisted')
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
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE landlord_id IS NOT NULL)::bigint,
    count(*) FILTER (WHERE landlord_id IS NULL)::bigint,
    count(*) FILTER (WHERE coalesce(array_length(image_urls, 1), 0) > 0)::bigint,
    count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::bigint,
    count(*) FILTER (WHERE nullif(btrim(coalesce(lc1_chairperson_name,'')),'') IS NOT NULL)::bigint,
    count(*) FILTER (WHERE is_hidden)::bigint,
    count(*) FILTER (WHERE NOT is_hidden)::bigint
  FROM matched;
END;
$function$;

-- ── 3. Paginated search (state-aware dates + hidden/visible quick filters) ─
CREATE OR REPLACE FUNCTION public.ops_search_house_listings(
  p_status    text        DEFAULT 'pending',
  p_search    text        DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL,
  p_sort      text        DEFAULT 'newest',
  p_limit     integer     DEFAULT 30,
  p_offset    integer     DEFAULT 0,
  p_quick     text        DEFAULT 'all'
)
RETURNS TABLE(listing jsonb, total_count bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
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
      hl.*,
      CASE
        WHEN hl.status = 'rejected' THEN coalesce(rj.rejected_at, hl.updated_at, hl.created_at)
        WHEN coalesce(hl.verified, false) THEN coalesce(hl.verified_at, hl.updated_at, hl.created_at)
        ELSE hl.created_at
      END AS activity_at,
      rj.rejection_reason,
      rj.rejected_at AS rejected_at,
      rb.full_name   AS rejected_by_name,
      vb.full_name   AS verified_by_name,
      ap.full_name AS agent_name,
      ap.phone     AS agent_phone,
      ap.email     AS agent_email,
      tp.full_name AS tenant_name,
      tp.phone     AS tenant_phone,
      to_jsonb(ll) AS landlord_json
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
  ), counted AS (
    SELECT count(*)::bigint AS n FROM matched
  )
  SELECT
    jsonb_build_object(
      'id', m.id,
      'title', m.title,
      'house_category', m.house_category,
      'monthly_rent', m.monthly_rent,
      'daily_rate', m.daily_rate,
      'number_of_rooms', m.number_of_rooms,
      'address', m.address,
      'district', m.district,
      'village', m.village,
      'region', m.region,
      'latitude', m.latitude,
      'longitude', m.longitude,
      'image_urls', m.image_urls,
      'lc1_chairperson_name', m.lc1_chairperson_name,
      'lc1_chairperson_phone', m.lc1_chairperson_phone,
      'lc1_chairperson_village', m.lc1_chairperson_village,
      'agent_id', m.agent_id,
      'landlord_id', m.landlord_id,
      'tenant_id', m.tenant_id,
      'verified', m.verified,
      'verified_at', m.verified_at,
      'verified_by', m.verified_by,
      'verified_by_name', m.verified_by_name,
      'rejection_reason', m.rejection_reason,
      'rejected_at', m.rejected_at,
      'rejected_by_name', m.rejected_by_name,
      'activity_at', m.activity_at,
      'listing_bonus_paid', m.listing_bonus_paid,
      'created_at', m.created_at,
      'updated_at', m.updated_at,
      'status', m.status,
      'is_hidden', m.is_hidden,
      'agent_name', m.agent_name,
      'agent_phone', m.agent_phone,
      'agent_email', m.agent_email,
      'tenant_name', m.tenant_name,
      'tenant_phone', m.tenant_phone,
      'landlords', CASE WHEN m.landlord_id IS NULL THEN NULL ELSE m.landlord_json END
    ) AS listing,
    c.n AS total_count
  FROM matched m CROSS JOIN counted c
  ORDER BY
    CASE WHEN lower(coalesce(p_sort,'newest')) = 'oldest' THEN m.activity_at END ASC,
    CASE WHEN lower(coalesce(p_sort,'newest')) = 'highest_rent' THEN coalesce(m.monthly_rent,0) END DESC,
    CASE WHEN lower(coalesce(p_sort,'newest')) = 'recently_updated' THEN coalesce(m.updated_at, m.created_at) END DESC,
    CASE WHEN lower(coalesce(p_sort,'newest')) NOT IN ('oldest','highest_rent','recently_updated') THEN m.activity_at END DESC
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

-- ── 4. Comprehensive report source (drives the exportable PDFs) ─
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
  v_limit int := least(greatest(coalesce(p_limit, 3000), 1), 10000);
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

  RETURN QUERY
  WITH src AS (
    SELECT s.listing, s.total_count
    FROM public.ops_search_house_listings(
      p_status, p_search, p_date_from, p_date_to, 'newest', 200, 0, p_quick
    ) s
    LIMIT 1
  ), rows AS (
    SELECT s.listing AS l, s.total_count AS n
    FROM public.ops_search_house_listings(
      p_status, p_search, p_date_from, p_date_to, 'newest', 200, 0, p_quick
    ) s
  )
  SELECT r.l, r.n FROM rows r LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_house_listing_report(text, text, timestamptz, timestamptz, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_house_listing_report(text, text, timestamptz, timestamptz, text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.ops_house_listing_status_counts(text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_house_listing_status_counts(text, timestamptz, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public.ops_house_quick_filter_counts(text, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_house_quick_filter_counts(text, text, timestamptz, timestamptz) TO authenticated;
