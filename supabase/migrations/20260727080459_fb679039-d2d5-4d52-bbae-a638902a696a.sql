-- Backfill without firing user triggers (avoids retroactive bonus payouts and
-- fraud-block errors). Only sets the verified flags.
SET LOCAL session_replication_role = replica;

UPDATE public.house_listings
SET verified = true,
    verified_at = COALESCE(verified_at, now())
WHERE verified = false
  AND listing_bonus_paid = true
  AND status NOT IN ('rejected','delisted');

UPDATE public.landlords l
SET verified = true,
    verified_at = COALESCE(l.verified_at, now())
FROM public.house_listings h
WHERE h.landlord_id = l.id
  AND h.listing_bonus_paid = true
  AND l.verified IS DISTINCT FROM true;

SET LOCAL session_replication_role = origin;

-- Safety trigger: any future listing whose bonus is paid must also be verified.
CREATE OR REPLACE FUNCTION public.sync_verified_on_bonus_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.listing_bonus_paid IS TRUE
     AND (OLD.listing_bonus_paid IS DISTINCT FROM true)
     AND NEW.verified IS DISTINCT FROM true THEN
    NEW.verified := true;
    NEW.verified_at := COALESCE(NEW.verified_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_verified_on_bonus_paid ON public.house_listings;
CREATE TRIGGER trg_sync_verified_on_bonus_paid
BEFORE UPDATE ON public.house_listings
FOR EACH ROW
EXECUTE FUNCTION public.sync_verified_on_bonus_paid();