-- Two-way house photo sync between house_listings.image_urls and rent_requests.house_image_urls
CREATE OR REPLACE FUNCTION public.sync_rent_request_images_from_listing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.image_urls IS NULL OR array_length(NEW.image_urls, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.rent_requests r
     SET house_image_urls = NEW.image_urls
   WHERE (
           r.house_listing_id = NEW.id
           OR (NEW.tenant_id IS NOT NULL AND r.tenant_id = NEW.tenant_id)
         )
     AND COALESCE(r.status, '') NOT IN ('rejected', 'deleted_by_agent', 'cancelled')
     AND COALESCE(r.house_image_urls, '{}') IS DISTINCT FROM NEW.image_urls;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_rent_request_images_from_listing ON public.house_listings;
CREATE TRIGGER trg_sync_rent_request_images_from_listing
AFTER UPDATE OF image_urls ON public.house_listings
FOR EACH ROW
WHEN (pg_trigger_depth() < 2 AND NEW.image_urls IS DISTINCT FROM OLD.image_urls)
EXECUTE FUNCTION public.sync_rent_request_images_from_listing();

CREATE OR REPLACE FUNCTION public.sync_listing_images_from_rent_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.house_image_urls IS NULL OR array_length(NEW.house_image_urls, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.house_listings l
     SET image_urls = NEW.house_image_urls
   WHERE (
           l.id = NEW.house_listing_id
           OR (NEW.tenant_id IS NOT NULL AND l.tenant_id = NEW.tenant_id)
         )
     AND COALESCE(l.image_urls, '{}') IS DISTINCT FROM NEW.house_image_urls;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_listing_images_from_rent_request ON public.rent_requests;
CREATE TRIGGER trg_sync_listing_images_from_rent_request
AFTER UPDATE OF house_image_urls ON public.rent_requests
FOR EACH ROW
WHEN (pg_trigger_depth() < 2 AND NEW.house_image_urls IS DISTINCT FROM OLD.house_image_urls)
EXECUTE FUNCTION public.sync_listing_images_from_rent_request();