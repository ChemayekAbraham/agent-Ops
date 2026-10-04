SET lock_timeout = '20s';
DROP TRIGGER IF EXISTS trg_enforce_daytime_house_listing ON public.house_listings;
CREATE TRIGGER trg_enforce_daytime_house_listing
  BEFORE INSERT ON public.house_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_daytime_house_listing();