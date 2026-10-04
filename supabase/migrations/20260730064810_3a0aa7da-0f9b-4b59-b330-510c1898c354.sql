CREATE OR REPLACE FUNCTION public.enforce_rent_request_tenant_photo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_exempt boolean := COALESCE(NEW.registration_type, '') IN ('renewal', 'outstanding_balance');
BEGIN
  IF NEW.tenant_photo_url IS NULL OR btrim(NEW.tenant_photo_url) = '' THEN
    SELECT tenant_photo_url INTO NEW.tenant_photo_url
    FROM public.rent_requests
    WHERE tenant_id = NEW.tenant_id
      AND tenant_photo_url IS NOT NULL
      AND btrim(tenant_photo_url) <> ''
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_exempt THEN
    RETURN NEW;
  END IF;

  IF NEW.tenant_photo_url IS NULL OR btrim(NEW.tenant_photo_url) = '' THEN
    RAISE EXCEPTION 'Tenant passport photo is required to submit a rent request'
      USING ERRCODE = 'check_violation',
            HINT = 'Upload the tenant''s passport photo before submitting.';
  END IF;
  RETURN NEW;
END;
$function$;