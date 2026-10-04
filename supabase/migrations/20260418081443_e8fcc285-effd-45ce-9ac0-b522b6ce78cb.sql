
-- =====================================================================
-- 1) RENT HISTORY VERIFICATION (Tenant Ops, Agent Ops, Landlord Ops)
--    Re-uses existing is_business_advance_ops(uuid) helper
-- =====================================================================

CREATE POLICY "Ops staff view all rent history"
ON public.rent_history_records
FOR SELECT
TO authenticated
USING (is_business_advance_ops(auth.uid()));

CREATE POLICY "Ops staff update rent history verification"
ON public.rent_history_records
FOR UPDATE
TO authenticated
USING (is_business_advance_ops(auth.uid()));

ALTER TABLE public.rent_history_records
  ADD COLUMN IF NOT EXISTS tenant_ops_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS tenant_ops_verified_by uuid,
  ADD COLUMN IF NOT EXISTS agent_ops_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_ops_verified_by uuid,
  ADD COLUMN IF NOT EXISTS landlord_ops_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS landlord_ops_verified_by uuid,
  ADD COLUMN IF NOT EXISTS verification_notes text;

CREATE INDEX IF NOT EXISTS idx_rhr_tenant_status
  ON public.rent_history_records(tenant_id, status);

-- =====================================================================
-- 2) LANDLORD PHYSICAL VERIFICATION  (Agent Ops -> nearby field agent)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.landlord_physical_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_advance_id uuid NOT NULL REFERENCES public.business_advances(id) ON DELETE CASCADE,
  rent_history_record_id uuid REFERENCES public.rent_history_records(id) ON DELETE SET NULL,

  landlord_name text NOT NULL,
  landlord_phone text NOT NULL,
  property_location text NOT NULL,
  property_latitude numeric,
  property_longitude numeric,

  assigned_agent_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  distance_km numeric,

  status text NOT NULL DEFAULT 'assigned',
  visited_at timestamptz,
  visit_latitude numeric,
  visit_longitude numeric,
  landlord_confirmed boolean,
  field_notes text,
  photo_urls text[],

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lpv_advance ON public.landlord_physical_verifications(business_advance_id);
CREATE INDEX IF NOT EXISTS idx_lpv_agent_status ON public.landlord_physical_verifications(assigned_agent_id, status);

ALTER TABLE public.landlord_physical_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops staff manage landlord physical verifications"
ON public.landlord_physical_verifications
FOR ALL
TO authenticated
USING (is_business_advance_ops(auth.uid()))
WITH CHECK (is_business_advance_ops(auth.uid()));

CREATE POLICY "Assigned agent views own physical verifications"
ON public.landlord_physical_verifications
FOR SELECT
TO authenticated
USING (assigned_agent_id = auth.uid());

CREATE POLICY "Assigned agent updates own physical verifications"
ON public.landlord_physical_verifications
FOR UPDATE
TO authenticated
USING (assigned_agent_id = auth.uid())
WITH CHECK (assigned_agent_id = auth.uid());

DROP TRIGGER IF EXISTS trg_lpv_updated_at ON public.landlord_physical_verifications;
CREATE TRIGGER trg_lpv_updated_at
BEFORE UPDATE ON public.landlord_physical_verifications
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================================
-- 3) NEAREST-AGENT SUGGESTION RPC
-- =====================================================================
CREATE OR REPLACE FUNCTION public.suggest_nearby_agents(
  _lat numeric,
  _lng numeric,
  _limit integer DEFAULT 5
)
RETURNS TABLE (
  agent_id uuid,
  full_name text,
  phone text,
  last_lat numeric,
  last_lng numeric,
  last_seen_at timestamptz,
  distance_km numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH last_visit AS (
    SELECT DISTINCT ON (av.agent_id)
      av.agent_id,
      av.latitude  AS last_lat,
      av.longitude AS last_lng,
      av.checked_in_at AS last_seen_at
    FROM public.agent_visits av
    WHERE av.latitude IS NOT NULL AND av.longitude IS NOT NULL
    ORDER BY av.agent_id, av.checked_in_at DESC
  )
  SELECT
    p.id AS agent_id,
    p.full_name,
    p.phone,
    lv.last_lat,
    lv.last_lng,
    lv.last_seen_at,
    ROUND(
      (2 * 6371 * asin(sqrt(
        power(sin(radians((lv.last_lat - _lat) / 2)), 2) +
        cos(radians(_lat)) * cos(radians(lv.last_lat)) *
        power(sin(radians((lv.last_lng - _lng) / 2)), 2)
      )))::numeric,
      2
    ) AS distance_km
  FROM public.profiles p
  JOIN public.user_roles ur
    ON ur.user_id = p.id AND ur.role = 'agent'::app_role
  LEFT JOIN last_visit lv ON lv.agent_id = p.id
  WHERE lv.last_lat IS NOT NULL
  ORDER BY distance_km ASC NULLS LAST
  LIMIT GREATEST(_limit, 1);
$$;

GRANT EXECUTE ON FUNCTION public.suggest_nearby_agents(numeric, numeric, integer) TO authenticated;
