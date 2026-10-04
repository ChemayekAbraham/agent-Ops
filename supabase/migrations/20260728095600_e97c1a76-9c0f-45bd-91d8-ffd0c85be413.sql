CREATE OR REPLACE FUNCTION public.enforce_rent_request_tenant_photo()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_photo_url IS NULL OR btrim(NEW.tenant_photo_url) = '' THEN
    RAISE EXCEPTION 'Tenant passport photo is required to submit a rent request'
      USING ERRCODE = 'check_violation',
            HINT = 'Upload the tenant''s passport photo before submitting.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_rent_request_tenant_photo ON public.rent_requests;
CREATE TRIGGER trg_enforce_rent_request_tenant_photo
BEFORE INSERT ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_rent_request_tenant_photo();