
-- Hard block: prevent tenant assignment if property lacks GPS or landlord
CREATE OR REPLACE FUNCTION public.enforce_property_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When a tenant is being assigned (tenant_id going from NULL to non-NULL)
  IF NEW.tenant_id IS NOT NULL AND (OLD.tenant_id IS NULL OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
    -- Must have GPS
    IF NEW.latitude IS NULL OR NEW.longitude IS NULL THEN
      RAISE EXCEPTION 'Cannot assign tenant: property must have GPS coordinates captured first.';
    END IF;
    -- Must have landlord
    IF NEW.landlord_id IS NULL THEN
      RAISE EXCEPTION 'Cannot assign tenant: property must be linked to a landlord first.';
    END IF;
    -- Must have agent
    IF NEW.agent_id IS NULL THEN
      RAISE EXCEPTION 'Cannot assign tenant: property must be linked to an agent first.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_property_chain ON public.house_listings;
CREATE TRIGGER trg_enforce_property_chain
  BEFORE UPDATE ON public.house_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_property_chain();

-- RPC to get chain health summary for dashboard
CREATE OR REPLACE FUNCTION public.get_chain_health_summary()
RETURNS TABLE(
  total_properties bigint,
  with_gps bigint,
  without_gps bigint,
  with_landlord bigint,
  without_landlord bigint,
  with_agent bigint,
  without_agent bigint,
  with_tenant bigint,
  fully_linked bigint,
  missing_photos bigint,
  unverified bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*)::bigint AS total_properties,
    COUNT(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 END)::bigint AS with_gps,
    COUNT(CASE WHEN latitude IS NULL OR longitude IS NULL THEN 1 END)::bigint AS without_gps,
    COUNT(CASE WHEN landlord_id IS NOT NULL THEN 1 END)::bigint AS with_landlord,
    COUNT(CASE WHEN landlord_id IS NULL THEN 1 END)::bigint AS without_landlord,
    COUNT(CASE WHEN agent_id IS NOT NULL THEN 1 END)::bigint AS with_agent,
    COUNT(CASE WHEN agent_id IS NULL THEN 1 END)::bigint AS without_agent,
    COUNT(CASE WHEN tenant_id IS NOT NULL THEN 1 END)::bigint AS with_tenant,
    COUNT(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL AND landlord_id IS NOT NULL AND agent_id IS NOT NULL THEN 1 END)::bigint AS fully_linked,
    COUNT(CASE WHEN image_urls IS NULL OR array_length(image_urls, 1) IS NULL THEN 1 END)::bigint AS missing_photos,
    COUNT(CASE WHEN verified IS NOT TRUE THEN 1 END)::bigint AS unverified
  FROM house_listings;
$$;
