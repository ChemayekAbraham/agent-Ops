-- Money In: filter the Agent Products and Services list by recovery type.
-- One shared classification so the tile breakdown and the transaction page can never disagree.

-- 1. Shared definition of the Agent Products and Services split.
CREATE OR REPLACE FUNCTION public._cfo_received_agent_product_for(
  p_category text, p_source_table text, p_is_bike_lease boolean)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p_category = 'bike_recovery_repayment'
      OR (p_source_table = 'merchandise_recovery_plans' AND COALESCE(p_is_bike_lease, false)) THEN 'bike'
    WHEN p_source_table = 'merchandise_recovery_plans'
      OR p_category = 'merchandise_recovery_repayment' THEN 'smartphone'
    ELSE 'advance'
  END;
$$;

REVOKE ALL ON FUNCTION public._cfo_received_agent_product_for(text, text, boolean) FROM public, anon;

-- 2. Tile breakdown now reads its classification from the shared rule.
CREATE OR REPLACE FUNCTION public.get_cfo_received_agent_products_breakdown(p_from date, p_to date)
RETURNS TABLE(product_key text, product_label text, amount numeric, tx_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH x AS (
    SELECT g.amount,
      public._cfo_received_agent_product_for(g.category, g.source_table, mp.is_bike_lease) AS k
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
      AND public._cfo_received_category_for(g.category) = 'agent'
  )
  SELECT x.k,
    CASE x.k WHEN 'smartphone' THEN 'Smartphone recoveries' WHEN 'bike' THEN 'Bike recoveries' ELSE 'Agent advance repayments' END,
    round(sum(x.amount), 2), count(*)
  FROM x GROUP BY x.k ORDER BY 3 DESC;
END $$;
REVOKE ALL ON FUNCTION public.get_cfo_received_agent_products_breakdown(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_received_agent_products_breakdown(date, date) TO authenticated;

-- 3. Transaction page gains p_type (smartphone | bike | advance).
DROP FUNCTION IF EXISTS public.get_cfo_received_by_category_page(date, date, text, text, integer, integer);

CREATE FUNCTION public.get_cfo_received_by_category_page(
  p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text,
  p_type text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone,
  category_key text, category_label text, ledger_category text, amount numeric, description text,
  reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text,
  transaction_group_id uuid, classification text, total_matched bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_from timestamptz; v_to timestamptz; v_search text := nullif(btrim(p_search), '');
        v_type text := nullif(btrim(lower(p_type)), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  IF v_type IS NOT NULL AND v_type NOT IN ('smartphone', 'bike', 'advance') THEN
    RAISE EXCEPTION 'unknown product type %', p_type USING ERRCODE = '22023';
  END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH f AS (
    SELECT g.id AS gid, g.transaction_date AS tdate,
           public._cfo_received_category_for(g.category) AS ckey,
           CASE WHEN v_type IS NOT NULL AND public._cfo_received_category_for(g.category) = 'agent'
                THEN public._cfo_received_agent_product_for(g.category, g.source_table, mp.is_bike_lease)
           END AS pkey
    FROM public.general_ledger g
    LEFT JOIN public.merchandise_recovery_plans mp
      ON v_type IS NOT NULL AND g.source_table = 'merchandise_recovery_plans' AND mp.id = g.source_id
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
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
      AND (v_type IS NULL OR f.pkey = v_type)
  ), pg AS (
    SELECT m.gid, m.tdate, m.ckey, m.n FROM m ORDER BY m.tdate DESC, m.gid
    LIMIT least(greatest(COALESCE(p_limit, 50), 1), 1000) OFFSET greatest(COALESCE(p_offset, 0), 0)
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'partner' THEN 'Partner Products and Services' WHEN 'land' THEN 'Land Products and Services'
           WHEN 'agent' THEN 'Agent Products and Services' WHEN 'fees' THEN 'Fees and Service Income'
           WHEN 'other_income' THEN 'Other Income' WHEN 'capital' THEN 'Share Capital' END,
         g.category, round(g.amount, 2), g.description, g.reference_id,
         COALESCE(cp.full_name, p.full_name), COALESCE(cp.phone, p.phone),
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_out' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END $$;

REVOKE ALL ON FUNCTION public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_received_by_category_page(date, date, text, text, text, integer, integer) TO authenticated;