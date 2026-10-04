CREATE INDEX IF NOT EXISTS idx_house_listings_rejected_purge
  ON public.house_listings (updated_at)
  WHERE status = 'rejected';

CREATE INDEX IF NOT EXISTS idx_agent_listing_rejections_listing
  ON public.agent_listing_rejections (listing_id);

CREATE INDEX IF NOT EXISTS idx_rent_requests_house_listing
  ON public.rent_requests (house_listing_id);

CREATE OR REPLACE FUNCTION public.list_purgeable_rejected_listings(p_days integer DEFAULT 14, p_limit integer DEFAULT 300)
RETURNS TABLE (id uuid, image_urls text[], video_url text, rejected_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT hl.id, hl.image_urls, hl.video_url, hl.updated_at
    FROM public.house_listings hl
    WHERE hl.status = 'rejected'
      AND hl.tenant_id IS NULL
      AND hl.suspended_tenant_id IS NULL
      AND hl.updated_at < now() - make_interval(days => p_days)
    ORDER BY hl.updated_at ASC
    LIMIT p_limit * 2
  )
  SELECT c.id, c.image_urls, c.video_url, c.updated_at AS rejected_at
  FROM candidates c
  WHERE NOT EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.house_listing_id = c.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.agent_listing_rejections r
      WHERE r.listing_id = c.id
        AND r.rejected_at >= now() - make_interval(days => p_days)
    )
  ORDER BY c.updated_at ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.list_purgeable_rejected_listings(integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_purgeable_rejected_listings(integer, integer) TO service_role;