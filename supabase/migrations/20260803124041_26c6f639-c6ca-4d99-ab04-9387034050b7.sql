CREATE TABLE public.rejected_listing_purge_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  cutoff_days integer NOT NULL DEFAULT 14,
  listings_deleted integer NOT NULL DEFAULT 0,
  media_files_deleted integer NOT NULL DEFAULT 0,
  bytes_freed bigint NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_by text NOT NULL DEFAULT 'cron',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.rejected_listing_purge_runs TO authenticated;
GRANT ALL ON public.rejected_listing_purge_runs TO service_role;

ALTER TABLE public.rejected_listing_purge_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view purge runs"
ON public.rejected_listing_purge_runs
FOR SELECT
TO authenticated
USING (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'cto'));

CREATE TRIGGER trg_rejected_listing_purge_runs_updated_at
BEFORE UPDATE ON public.rejected_listing_purge_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.list_purgeable_rejected_listings(p_days integer DEFAULT 14, p_limit integer DEFAULT 300)
RETURNS TABLE (id uuid, image_urls text[], video_url text, rejected_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT hl.id,
         hl.image_urls,
         hl.video_url,
         COALESCE((SELECT max(r.rejected_at) FROM public.agent_listing_rejections r WHERE r.listing_id = hl.id), hl.updated_at) AS rejected_at
  FROM public.house_listings hl
  WHERE hl.status = 'rejected'
    AND hl.tenant_id IS NULL
    AND hl.suspended_tenant_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.house_listing_id = hl.id)
    AND COALESCE((SELECT max(r.rejected_at) FROM public.agent_listing_rejections r WHERE r.listing_id = hl.id), hl.updated_at) < now() - make_interval(days => p_days)
  ORDER BY COALESCE((SELECT max(r.rejected_at) FROM public.agent_listing_rejections r WHERE r.listing_id = hl.id), hl.updated_at) ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.list_purgeable_rejected_listings(integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_purgeable_rejected_listings(integer, integer) TO service_role;