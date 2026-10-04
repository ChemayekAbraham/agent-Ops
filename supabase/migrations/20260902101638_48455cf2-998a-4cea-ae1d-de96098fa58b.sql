CREATE OR REPLACE FUNCTION public.enforce_rent_request_landlord_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.landlord_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT public.landlord_has_current_agreement(NEW.landlord_id) THEN
    RAISE EXCEPTION 'LANDLORD_AGREEMENT_REQUIRED'
      USING ERRCODE = '23514',
            DETAIL = 'A current signed 12-month landlord agreement is required before posting a rent request.';
  END IF;

  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.landlord_has_current_signed_agreement(uuid);
REVOKE ALL ON FUNCTION public.enforce_rent_request_landlord_agreement() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_rent_request_landlord_agreement() TO service_role;