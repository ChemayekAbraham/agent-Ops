CREATE OR REPLACE FUNCTION public.empty_house_opportunity_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'house_count', COUNT(*),
    'total_rent_needed', COALESCE(SUM(COALESCE(h.monthly_rent, 0)), 0),
    'monthly_return_if_all_funded', COALESCE(SUM(ROUND(COALESCE(h.monthly_rent, 0) * 0.15)), 0)
  )
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden, false) = false
    AND COALESCE(h.monthly_rent, 0) > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.promissory_note_house_intents i
      WHERE i.house_id = h.id AND i.status = 'reserved'
    );
$$;

GRANT EXECUTE ON FUNCTION public.empty_house_opportunity_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.empty_house_opportunity_summary() TO service_role;