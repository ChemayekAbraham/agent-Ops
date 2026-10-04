CREATE OR REPLACE FUNCTION public.landlord_has_current_signed_agreement(p_landlord_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.landlord_agreements a
    WHERE a.landlord_id = p_landlord_id
      AND a.is_current = true
      AND a.status = 'active'
      AND a.end_date >= current_date
  );
$$;

REVOKE ALL ON FUNCTION public.landlord_has_current_signed_agreement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_has_current_signed_agreement(uuid) TO authenticated;

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

  IF NOT public.landlord_has_current_signed_agreement(NEW.landlord_id) THEN
    RAISE EXCEPTION 'LANDLORD_AGREEMENT_REQUIRED'
      USING ERRCODE = '23514',
            DETAIL = 'A current signed 12-month landlord agreement is required before posting a rent request.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_rent_request_landlord_agreement ON public.rent_requests;
CREATE TRIGGER trg_enforce_rent_request_landlord_agreement
  BEFORE INSERT ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_rent_request_landlord_agreement();

GRANT EXECUTE ON FUNCTION public.enforce_rent_request_landlord_agreement() TO service_role;