-- Auto-verify LC1 chairpersons the moment they are registered.
CREATE OR REPLACE FUNCTION public.auto_verify_lc1_chairperson()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.verified IS NOT TRUE THEN
    NEW.verified := true;
    NEW.verified_at := COALESCE(NEW.verified_at, now());
    NEW.verified_by := COALESCE(NEW.verified_by, NEW.registered_by, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_verify_lc1_chairperson ON public.lc1_chairpersons;
CREATE TRIGGER trg_auto_verify_lc1_chairperson
  BEFORE INSERT ON public.lc1_chairpersons
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_verify_lc1_chairperson();

-- Backfill: mark existing unverified LC1 chairpersons as verified.
UPDATE public.lc1_chairpersons
SET verified = true,
    verified_at = COALESCE(verified_at, now()),
    verified_by = COALESCE(verified_by, registered_by)
WHERE verified IS NOT TRUE;