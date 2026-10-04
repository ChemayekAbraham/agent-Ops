CREATE OR REPLACE FUNCTION public.welile_mission_landlord_receivables(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS TABLE (
  landlord_id uuid,
  landlord_name text,
  landlord_phone text,
  property_address text,
  receivable_total numeric,
  placement_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.id AS landlord_id,
    l.name AS landlord_name,
    l.phone AS landlord_phone,
    l.property_address AS property_address,
    COALESCE(SUM(lal.amount), 0)::numeric AS receivable_total,
    COUNT(DISTINCT lal.rent_request_id)::bigint AS placement_count
  FROM public.landlord_account_ledger lal
  JOIN public.landlords l ON l.id = lal.landlord_id
  WHERE lal.entry_type = 'receivable'
    AND public.is_ops_role(auth.uid())
    AND (p_from IS NULL OR lal.created_at >= p_from)
    AND (p_to IS NULL OR lal.created_at < p_to)
  GROUP BY l.id, l.name, l.phone, l.property_address
  ORDER BY receivable_total DESC
  LIMIT 500;
$$;

GRANT EXECUTE ON FUNCTION public.welile_mission_landlord_receivables(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.welile_mission_landlord_receivables(timestamptz, timestamptz) TO service_role;