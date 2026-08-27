REVOKE EXECUTE ON FUNCTION public.sync_rent_request_images_from_listing() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_listing_images_from_rent_request() FROM anon, authenticated, PUBLIC;

UPDATE public.rent_requests r
   SET house_image_urls = l.image_urls
  FROM public.house_listings l
 WHERE (r.house_listing_id = l.id OR (l.tenant_id IS NOT NULL AND r.tenant_id = l.tenant_id))
   AND l.image_urls IS NOT NULL
   AND array_length(l.image_urls, 1) IS NOT NULL
   AND COALESCE(r.status, '') NOT IN ('rejected', 'deleted_by_agent', 'cancelled')
   AND COALESCE(r.house_image_urls, '{}') IS DISTINCT FROM l.image_urls;