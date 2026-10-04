-- Relax tenant passport photo requirement for renewals (outstanding_balance).
-- Renewals reuse an existing tenant who already has a photo on file, so we
-- don't force a re-upload at renewal time.
CREATE OR REPLACE FUNCTION public.enforce_rent_request_tenant_photo()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Skip enforcement for renewals / outstanding-balance rollovers.
  IF NEW.registration_type IS NOT NULL
     AND NEW.registration_type IN ('outstanding_balance', 'renewal') THEN
    RETURN NEW;
  END IF;

  IF NEW.tenant_photo_url IS NULL OR btrim(NEW.tenant_photo_url) = '' THEN
    RAISE EXCEPTION 'Tenant passport photo is required to submit a rent request'
      USING ERRCODE = 'check_violation',
            HINT = 'Upload the tenant''s passport photo before submitting.';
  END IF;
  RETURN NEW;
END;
$$;
