-- Server-side guarantee: a rent request can only be created (or have its
-- landlord changed) when the landlord is actually registered in the system.
-- The existing foreign key only guarantees a non-null landlord_id points to a
-- real row; it still allows NULL. This trigger closes that gap with a clear,
-- explicit error message instead of relying on FK/NOT NULL alone.

CREATE OR REPLACE FUNCTION public.enforce_rent_request_landlord_registered()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A landlord must always be attached.
  IF NEW.landlord_id IS NULL THEN
    RAISE EXCEPTION 'A rent request requires a registered landlord. Register or select the landlord before posting.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The attached landlord must exist (i.e. be registered) in the system.
  IF NOT EXISTS (
    SELECT 1 FROM public.landlords l WHERE l.id = NEW.landlord_id
  ) THEN
    RAISE EXCEPTION 'The selected landlord is not registered in the system. Register the landlord before posting this rent request.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_rent_request_landlord_registered ON public.rent_requests;

CREATE TRIGGER trg_enforce_rent_request_landlord_registered
BEFORE INSERT OR UPDATE OF landlord_id ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_rent_request_landlord_registered();