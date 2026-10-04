DROP FUNCTION IF EXISTS public.welile_mission_receivables(timestamp with time zone);

CREATE OR REPLACE FUNCTION public.welile_mission_receivables(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(placed_receivable_total numeric, placed_receivable_count bigint, empty_receivable_total numeric, empty_houses_count bigint, unlisted_receivable_total numeric, unlisted_landlord_count bigint, earliest_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_earliest timestamptz;
BEGIN
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- compute earliest date across empty listings and unlisted landlords
  SELECT LEAST(
    (SELECT MIN(created_at) FROM public.house_listings WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false),
    (SELECT MIN(created_at) FROM public.landlords l
     WHERE l.registered_by IS NOT NULL
       AND l.tenant_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id))
  ) INTO v_earliest;

  RETURN QUERY
  WITH unlisted AS (
    SELECT l.id, COALESCE(l.monthly_rent, l.desired_rent_from_welile, 0) AS rent
    FROM public.landlords l
    WHERE l.registered_by IS NOT NULL
      AND l.tenant_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id)
      AND (p_since IS NULL OR l.created_at >= p_since)
  )
  SELECT
    COALESCE((SELECT SUM(amount) FROM public.landlord_account_ledger WHERE entry_type = 'receivable'), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.landlord_account_ledger WHERE entry_type = 'receivable'), 0)::bigint,
    COALESCE((SELECT SUM(monthly_rent) * 12 FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
                AND (p_since IS NULL OR created_at >= p_since)), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM public.house_listings
              WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
                AND (p_since IS NULL OR created_at >= p_since)), 0)::bigint,
    COALESCE((SELECT SUM(rent) * 12 FROM unlisted), 0)::numeric,
    COALESCE((SELECT COUNT(*) FROM unlisted), 0)::bigint,
    v_earliest;
END;
$function$;