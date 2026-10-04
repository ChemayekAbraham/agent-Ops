
-- Add Uber-inspired verification columns to property_viewings
ALTER TABLE public.property_viewings
  ADD COLUMN viewing_pin TEXT DEFAULT lpad(floor(random() * 10000)::text, 4, '0'),
  ADD COLUMN pin_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN pin_verified_at TIMESTAMPTZ,
  ADD COLUMN proximity_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN proximity_distance_m DOUBLE PRECISION,
  ADD COLUMN agent_checkin_at TIMESTAMPTZ,
  ADD COLUMN tenant_checkin_lat DOUBLE PRECISION,
  ADD COLUMN tenant_checkin_lng DOUBLE PRECISION,
  ADD COLUMN tenant_checkin_at TIMESTAMPTZ,
  ADD COLUMN agent_rating SMALLINT,
  ADD COLUMN tenant_rating SMALLINT,
  ADD COLUMN agent_feedback TEXT,
  ADD COLUMN tenant_feedback TEXT,
  ADD COLUMN agent_rated_at TIMESTAMPTZ,
  ADD COLUMN tenant_rated_at TIMESTAMPTZ,
  ADD COLUMN meeting_verified BOOLEAN GENERATED ALWAYS AS (
    pin_verified AND proximity_verified
  ) STORED;

-- Auto-generate unique 4-digit PINs for new viewings
CREATE OR REPLACE FUNCTION public.generate_viewing_pin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.viewing_pin IS NULL THEN
    NEW.viewing_pin := lpad(floor(random() * 10000)::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_generate_viewing_pin
  BEFORE INSERT ON public.property_viewings
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_viewing_pin();

-- Allow agents and tenants to update their own check-in and rating fields
CREATE POLICY "Agents can update own check-in and rating"
ON public.property_viewings
FOR UPDATE
TO authenticated
USING (agent_id = auth.uid())
WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Tenants can update own check-in and rating"
ON public.property_viewings
FOR UPDATE
TO authenticated
USING (tenant_id = auth.uid())
WITH CHECK (tenant_id = auth.uid());
