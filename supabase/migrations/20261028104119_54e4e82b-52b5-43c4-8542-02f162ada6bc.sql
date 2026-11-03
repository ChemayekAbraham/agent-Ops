CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz; v_to timestamptz;
  v_search text := nullif(btrim(p_search), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  RETURN QUERY
  WITH f AS (
    SELECT g.id AS gid, g.transaction_date AS tdate, public._cfo_paid_category_for(g.category) AS ckey
    FROM public.general_ledger g
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    WHERE g.direction = 'cash_out'
      AND g.classification IN ('production', 'legacy_real')
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND (v_search IS NULL OR COALESCE(g.description, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.reference_id, '') ILIKE '%' || v_search || '%'
           OR COALESCE(g.linked_party, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.full_name, '') ILIKE '%' || v_search || '%'
           OR COALESCE(sp.phone, '') ILIKE '%' || v_search || '%')
  ), m AS (
    SELECT f.gid, f.tdate, f.ckey, count(*) OVER () AS n
    FROM f WHERE f.ckey IS NOT NULL AND (p_category IS NULL OR f.ckey = p_category)
  ), pg AS (
    SELECT m.gid, m.tdate, m.ckey, m.n FROM m
    ORDER BY m.tdate DESC, m.gid
    LIMIT least(greatest(COALESCE(p_limit, 50), 1), 1000)
    OFFSET greatest(COALESCE(p_offset, 0), 0)
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'budget' THEN 'Operational Expenses' WHEN 'landlord_float' THEN 'Landlord Float'
           WHEN 'agent' THEN 'Agent Commissions' WHEN 'partner' THEN 'Partner Products and Services'
           WHEN 'landlord' THEN 'Land Products and Services' WHEN 'marketing' THEN 'Marketing Expenses'
           WHEN 'rnd' THEN 'Product Research & Development' END,
         g.category, round(g.amount, 2), g.description, g.reference_id,
         p.full_name, p.phone, g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END
$function$;