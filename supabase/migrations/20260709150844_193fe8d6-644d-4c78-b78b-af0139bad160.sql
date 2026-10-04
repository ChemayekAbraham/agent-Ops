-- ============================================================
-- FIX 1: location_requests — remove header-token RLS UPDATE,
-- move to SECURITY DEFINER function with server-side token check
-- ============================================================
DROP POLICY IF EXISTS "Public can update pending with matching token header" ON public.location_requests;

CREATE OR REPLACE FUNCTION public.capture_location_by_token(
  p_token uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_token IS NULL OR p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION 'Missing required location data';
  END IF;

  IF p_latitude < -90 OR p_latitude > 90 OR p_longitude < -180 OR p_longitude > 180 THEN
    RAISE EXCEPTION 'Invalid coordinates';
  END IF;

  UPDATE public.location_requests
     SET latitude   = p_latitude,
         longitude  = p_longitude,
         accuracy   = p_accuracy,
         captured_at = now(),
         status     = 'captured'
   WHERE token = p_token
     AND status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_location_by_token(uuid, double precision, double precision, double precision) FROM public;
GRANT EXECUTE ON FUNCTION public.capture_location_by_token(uuid, double precision, double precision, double precision) TO anon, authenticated;

-- ============================================================
-- FIX 2: profiles — tie agent inserts to a real relationship
-- ============================================================
DROP POLICY IF EXISTS "Agents can insert profiles for tenants" ON public.profiles;

CREATE POLICY "Agents can insert profiles for tenants"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND (
    EXISTS (
      SELECT 1 FROM public.rent_requests rr
      WHERE rr.tenant_id = profiles.id
        AND (rr.agent_id = auth.uid() OR rr.assigned_agent_id = auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.referrals r
      WHERE r.referred_id = profiles.id
        AND r.referrer_id = auth.uid()
    )
  )
);

-- ============================================================
-- FIX 5: public_rent_history_submissions — require real agent
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_public_rent_history_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.agent_id IS NULL OR NOT public.has_role(NEW.agent_id, 'agent'::app_role) THEN
    RAISE EXCEPTION 'Submission must be attributed to a valid agent';
  END IF;

  IF length(NEW.submitter_name)  > 200 OR length(NEW.submitter_phone)  > 30
  OR length(NEW.landlord_name)   > 200 OR length(NEW.landlord_phone)   > 30
  OR length(NEW.property_location) > 500
  OR length(coalesce(NEW.notes, '')) > 2000 THEN
    RAISE EXCEPTION 'One or more fields exceed allowed length';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_public_rent_history_submission ON public.public_rent_history_submissions;
CREATE TRIGGER trg_validate_public_rent_history_submission
BEFORE INSERT ON public.public_rent_history_submissions
FOR EACH ROW EXECUTE FUNCTION public.validate_public_rent_history_submission();

-- ============================================================
-- FIX 4: landlord_leads — clear bogus referrer + length limits
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_landlord_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Drop attribution to any non-agent id to prevent commission fraud
  IF NEW.referrer_agent_id IS NOT NULL
     AND NOT public.has_role(NEW.referrer_agent_id, 'agent'::app_role) THEN
    NEW.referrer_agent_id := NULL;
  END IF;

  IF length(coalesce(NEW.full_name, '')) = 0 OR length(NEW.full_name) > 200
  OR length(coalesce(NEW.phone, '')) = 0 OR length(NEW.phone) > 30
  OR length(coalesce(NEW.property_location, '')) = 0 OR length(NEW.property_location) > 500
  OR length(coalesce(NEW.campaign, '')) > 200 THEN
    RAISE EXCEPTION 'One or more fields are missing or exceed allowed length';
  END IF;

  IF NEW.number_of_units IS NULL OR NEW.number_of_units < 1 OR NEW.number_of_units > 100000 THEN
    RAISE EXCEPTION 'Invalid number of units';
  END IF;

  IF NEW.rent_per_unit IS NULL OR NEW.rent_per_unit < 0 THEN
    RAISE EXCEPTION 'Invalid rent per unit';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_landlord_lead ON public.landlord_leads;
CREATE TRIGGER trg_validate_landlord_lead
BEFORE INSERT ON public.landlord_leads
FOR EACH ROW EXECUTE FUNCTION public.validate_landlord_lead();

-- ============================================================
-- FIX 3: public intake forms — length/format validation
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_job_application()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF length(coalesce(NEW.full_name, '')) = 0 OR length(NEW.full_name) > 200
  OR length(coalesce(NEW.whatsapp_number, '')) = 0 OR length(NEW.whatsapp_number) > 30
  OR length(coalesce(NEW.email, '')) > 255
  OR length(coalesce(NEW.category, '')) = 0 OR length(NEW.category) > 100
  OR length(coalesce(NEW.role_interest, '')) > 200
  OR length(coalesce(NEW.experience_level, '')) > 100
  OR length(coalesce(NEW.portfolio_url, '')) > 500
  OR length(coalesce(NEW.location, '')) > 200
  OR length(coalesce(NEW.cover_note, '')) > 5000 THEN
    RAISE EXCEPTION 'One or more fields are missing or exceed allowed length';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_job_application ON public.job_applications;
CREATE TRIGGER trg_validate_job_application
BEFORE INSERT ON public.job_applications
FOR EACH ROW EXECUTE FUNCTION public.validate_job_application();

CREATE OR REPLACE FUNCTION public.validate_internship_application()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF length(coalesce(NEW.full_name, '')) = 0 OR length(NEW.full_name) > 200
  OR length(coalesce(NEW.phone, '')) = 0 OR length(NEW.phone) > 30
  OR length(coalesce(NEW.email, '')) > 255
  OR length(coalesce(NEW.motivation, '')) > 5000
  OR length(coalesce(NEW.skills, '')) > 2000
  OR length(coalesce(NEW.referral_code, '')) > 100 THEN
    RAISE EXCEPTION 'One or more fields are missing or exceed allowed length';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_internship_application ON public.internship_applications;
CREATE TRIGGER trg_validate_internship_application
BEFORE INSERT ON public.internship_applications
FOR EACH ROW EXECUTE FUNCTION public.validate_internship_application();

CREATE OR REPLACE FUNCTION public.validate_career_link_click()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF length(coalesce(NEW.utm_source, '')) > 200
  OR length(coalesce(NEW.utm_medium, '')) > 200
  OR length(coalesce(NEW.utm_campaign, '')) > 200
  OR length(coalesce(NEW.referrer, '')) > 1000
  OR length(coalesce(NEW.landing_path, '')) > 1000 THEN
    RAISE EXCEPTION 'One or more fields exceed allowed length';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_career_link_click ON public.career_link_clicks;
CREATE TRIGGER trg_validate_career_link_click
BEFORE INSERT ON public.career_link_clicks
FOR EACH ROW EXECUTE FUNCTION public.validate_career_link_click();