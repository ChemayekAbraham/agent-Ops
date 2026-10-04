-- 1. Tenant-scoped detail columns on the tenant's own record
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tenant_house_listing_id uuid,
  ADD COLUMN IF NOT EXISTS tenant_house_category text,
  ADD COLUMN IF NOT EXISTS tenant_water_meter text,
  ADD COLUMN IF NOT EXISTS tenant_electricity_meter text,
  ADD COLUMN IF NOT EXISTS preferred_language text,
  ADD COLUMN IF NOT EXISTS tenant_details_updated_at timestamptz;

-- 2. Carry tenant details FORWARD onto a new rent request when the agent left them blank.
--    Fires before the GPS / landlord / photo enforcement triggers (name sorts first).
CREATE OR REPLACE FUNCTION public.carry_forward_tenant_details()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p RECORD;
  prev RECORD;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT borrower_landlord_id, borrower_lc1_id, tenant_house_listing_id,
         tenant_house_category, tenant_water_meter, tenant_electricity_meter,
         preferred_language, has_smartphone, residence_lat, residence_lng, city, town
    INTO p
    FROM public.profiles
   WHERE id = NEW.tenant_id;

  -- Latest prior request acts as the secondary source of truth.
  SELECT landlord_id, lc1_id, house_listing_id, house_category,
         tenant_water_meter, tenant_electricity_meter, preferred_language,
         tenant_no_smartphone, request_latitude, request_longitude, request_city, request_country
    INTO prev
    FROM public.rent_requests
   WHERE tenant_id = NEW.tenant_id
   ORDER BY created_at DESC
   LIMIT 1;

  NEW.landlord_id       := COALESCE(NEW.landlord_id, p.borrower_landlord_id, prev.landlord_id);
  NEW.lc1_id            := COALESCE(NEW.lc1_id, p.borrower_lc1_id, prev.lc1_id);
  NEW.house_listing_id  := COALESCE(NEW.house_listing_id, p.tenant_house_listing_id, prev.house_listing_id);
  NEW.house_category    := COALESCE(NEW.house_category, p.tenant_house_category, prev.house_category);
  NEW.tenant_water_meter       := COALESCE(NEW.tenant_water_meter, p.tenant_water_meter, prev.tenant_water_meter);
  NEW.tenant_electricity_meter := COALESCE(NEW.tenant_electricity_meter, p.tenant_electricity_meter, prev.tenant_electricity_meter);
  NEW.preferred_language := COALESCE(NEW.preferred_language, p.preferred_language, prev.preferred_language);
  NEW.request_city       := COALESCE(NEW.request_city, prev.request_city, p.town, p.city);
  NEW.request_country    := COALESCE(NEW.request_country, prev.request_country, 'Uganda');

  IF NEW.tenant_no_smartphone IS NULL THEN
    NEW.tenant_no_smartphone := COALESCE(
      CASE WHEN p.has_smartphone IS NULL THEN NULL ELSE NOT p.has_smartphone END,
      prev.tenant_no_smartphone
    );
  END IF;

  -- GPS: only inherit the tenant's own recorded residence / last request point.
  IF NEW.request_latitude IS NULL OR NEW.request_longitude IS NULL THEN
    IF p.residence_lat IS NOT NULL AND p.residence_lng IS NOT NULL THEN
      NEW.request_latitude  := p.residence_lat;
      NEW.request_longitude := p.residence_lng;
    ELSIF prev.request_latitude IS NOT NULL AND prev.request_longitude IS NOT NULL THEN
      NEW.request_latitude  := prev.request_latitude;
      NEW.request_longitude := prev.request_longitude;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_a_carry_forward_tenant_details ON public.rent_requests;
CREATE TRIGGER trg_a_carry_forward_tenant_details
BEFORE INSERT ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.carry_forward_tenant_details();

-- 3. Push the details captured on a request back onto the tenant record so they
--    can never be orphaned on the request row again.
CREATE OR REPLACE FUNCTION public.sync_tenant_details_to_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.profiles pr
     SET borrower_landlord_id      = COALESCE(NEW.landlord_id, pr.borrower_landlord_id),
         borrower_lc1_id           = COALESCE(NEW.lc1_id, pr.borrower_lc1_id),
         tenant_house_listing_id   = COALESCE(NEW.house_listing_id, pr.tenant_house_listing_id),
         tenant_house_category     = COALESCE(NEW.house_category, pr.tenant_house_category),
         tenant_water_meter        = COALESCE(NEW.tenant_water_meter, pr.tenant_water_meter),
         tenant_electricity_meter  = COALESCE(NEW.tenant_electricity_meter, pr.tenant_electricity_meter),
         preferred_language        = COALESCE(NEW.preferred_language, pr.preferred_language),
         has_smartphone            = COALESCE(
                                       CASE WHEN NEW.tenant_no_smartphone IS NULL THEN NULL
                                            ELSE NOT NEW.tenant_no_smartphone END,
                                       pr.has_smartphone),
         residence_lat             = COALESCE(pr.residence_lat, NEW.request_latitude),
         residence_lng             = COALESCE(pr.residence_lng, NEW.request_longitude),
         town                      = COALESCE(pr.town, NEW.request_city),
         tenant_details_updated_at = now(),
         updated_at                = now()
   WHERE pr.id = NEW.tenant_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_tenant_details_to_profile ON public.rent_requests;
CREATE TRIGGER trg_sync_tenant_details_to_profile
AFTER INSERT OR UPDATE OF landlord_id, lc1_id, house_listing_id, house_category,
  tenant_water_meter, tenant_electricity_meter, preferred_language,
  tenant_no_smartphone, request_latitude, request_longitude, request_city
ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.sync_tenant_details_to_profile();

-- 4. Consolidated read helper for UI surfaces
CREATE OR REPLACE FUNCTION public.get_tenant_details(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'tenant_id', pr.id,
    'full_name', pr.full_name,
    'phone', pr.phone,
    'national_id', pr.national_id,
    'landlord_id', pr.borrower_landlord_id,
    'landlord_name', l.full_name,
    'landlord_phone', l.phone,
    'lc1_id', pr.borrower_lc1_id,
    'lc1_name', c.full_name,
    'house_listing_id', pr.tenant_house_listing_id,
    'house_category', pr.tenant_house_category,
    'water_meter', pr.tenant_water_meter,
    'electricity_meter', pr.tenant_electricity_meter,
    'preferred_language', pr.preferred_language,
    'has_smartphone', pr.has_smartphone,
    'residence_lat', pr.residence_lat,
    'residence_lng', pr.residence_lng,
    'district', pr.district,
    'sub_county', pr.sub_county,
    'parish', pr.parish,
    'village', pr.village,
    'ug_village_id', pr.ug_village_id,
    'details_updated_at', pr.tenant_details_updated_at
  )
  FROM public.profiles pr
  LEFT JOIN public.profiles l ON l.id = pr.borrower_landlord_id
  LEFT JOIN public.profiles c ON c.id = pr.borrower_lc1_id
  WHERE pr.id = p_tenant_id
    AND (
      auth.uid() = pr.id
      OR public.is_ops_role(auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.rent_requests rr
         WHERE rr.tenant_id = pr.id
           AND (rr.agent_id = auth.uid() OR rr.assigned_agent_id = auth.uid())
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_details(uuid) TO authenticated;