CREATE OR REPLACE FUNCTION public.welile_mission_receivables()
RETURNS TABLE (
  placed_receivable_total numeric,
  placed_receivable_count bigint,
  empty_receivable_total numeric,
  empty_houses_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE((SELECT SUM(amount) FROM public.landlord_account_ledger WHERE entry_type = 'receivable'), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.landlord_account_ledger WHERE entry_type = 'receivable'), 0)::bigint,
    COALESCE((SELECT SUM(monthly_rent) * 12 FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false), 0)::bigint;
END;
$$;

GRANT EXECUTE ON FUNCTION public.welile_mission_receivables() TO authenticated;
GRANT EXECUTE ON FUNCTION public.welile_mission_receivables() TO service_role;