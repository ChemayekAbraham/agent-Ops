CREATE OR REPLACE FUNCTION public.enforce_listing_has_landlord()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  text;
  v_phone text;
BEGIN
  IF NEW.landlord_id IS NULL THEN
    RAISE EXCEPTION 'A house listing must be linked to a landlord (name and phone are required).'
      USING ERRCODE = '23514';
  END IF;

  SELECT name, phone INTO v_name, v_phone
  FROM public.landlords
  WHERE id = NEW.landlord_id;

  IF v_name IS NULL OR btrim(v_name) = '' THEN
    RAISE EXCEPTION 'The linked landlord must have a name before a listing can be created.'
      USING ERRCODE = '23514';
  END IF;

  IF v_phone IS NULL OR btrim(v_phone) = '' THEN
    RAISE EXCEPTION 'The linked landlord must have a phone number before a listing can be created.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_listing_has_landlord ON public.house_listings;
CREATE TRIGGER trg_enforce_listing_has_landlord
  BEFORE INSERT ON public.house_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_listing_has_landlord();