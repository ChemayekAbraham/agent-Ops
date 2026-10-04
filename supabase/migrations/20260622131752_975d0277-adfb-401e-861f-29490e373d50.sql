CREATE OR REPLACE FUNCTION public.prevent_duplicate_location_gps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clash_name TEXT;
BEGIN
  -- Only guard active rows that actually have coordinates
  IF NEW.active IS NOT TRUE OR NEW.latitude IS NULL OR NEW.longitude IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT name INTO clash_name
  FROM public.managed_locations m
  WHERE m.id <> NEW.id
    AND m.active IS TRUE
    AND m.latitude IS NOT NULL
    AND m.longitude IS NOT NULL
    -- same administrative area (district + region, case/space-insensitive)
    AND lower(coalesce(trim(m.district), '')) = lower(coalesce(trim(NEW.district), ''))
    AND lower(coalesce(trim(m.region), ''))   = lower(coalesce(trim(NEW.region), ''))
    -- same GPS point to ~5 decimal places (~1.1 m)
    AND round(m.latitude::numeric, 5)  = round(NEW.latitude::numeric, 5)
    AND round(m.longitude::numeric, 5) = round(NEW.longitude::numeric, 5)
  LIMIT 1;

  IF clash_name IS NOT NULL THEN
    RAISE EXCEPTION 'These GPS coordinates are already used by "%" in this administrative area (% / %). Each location in the same area must have unique coordinates.',
      clash_name,
      coalesce(NULLIF(trim(NEW.district), ''), 'no district'),
      coalesce(NULLIF(trim(NEW.region), ''), 'no region')
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_duplicate_location_gps ON public.managed_locations;
CREATE TRIGGER trg_prevent_duplicate_location_gps
BEFORE INSERT OR UPDATE OF latitude, longitude, district, region, active
ON public.managed_locations
FOR EACH ROW
EXECUTE FUNCTION public.prevent_duplicate_location_gps();