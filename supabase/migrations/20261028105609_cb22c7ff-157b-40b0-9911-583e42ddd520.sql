CREATE INDEX IF NOT EXISTS idx_gl_received_cashin_txdate ON public.general_ledger (transaction_date DESC, id) INCLUDE (category)
  WHERE direction = 'cash_in' AND ledger_scope = 'platform' AND classification IN ('production','legacy_real');

CREATE OR REPLACE FUNCTION public._cfo_received_category_for(p_category text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE p_category
    WHEN 'partner_funding' THEN 'partner'
    WHEN 'tenant_repayment_collected' THEN 'land'
    WHEN 'tenant_repayment' THEN 'land'
    WHEN 'landlord_receivable_collected' THEN 'land'
    WHEN 'agent_advance_repayment' THEN 'agent'
    WHEN 'agent_repayment' THEN 'agent'
    WHEN 'bike_recovery_repayment' THEN 'agent'
    WHEN 'merchandise_recovery_repayment' THEN 'agent'
    WHEN 'platform_fee_collected' THEN 'fees'
    WHEN 'access_fee_collected' THEN 'fees'
    WHEN 'agent_advance_fee_revenue' THEN 'fees'
    WHEN 'agent_advance_access_fee_collected' THEN 'fees'
    WHEN 'agent_advance_registration_fee_collected' THEN 'fees'
    WHEN 'listing_rejection_recovery' THEN 'other_income'
    WHEN 'share_capital' THEN 'capital'
    ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_totals(p_from date, p_to date)
RETURNS TABLE(category_key text, category_label text, nature text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH legs AS (
    SELECT public._cfo_received_category_for(g.category) AS cat_key, g.amount AS amt
    FROM public.general_ledger g
    WHERE g.direction = 'cash_in' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production', 'legacy_real')
      AND g.transaction_date >= v_from AND g.transaction_date < v_to
  ), agg AS (
    SELECT cl.cat_key, sum(cl.amt) AS amt, count(*) AS n FROM legs cl WHERE cl.cat_key IS NOT NULL GROUP BY cl.cat_key
  ), grand AS (SELECT COALESCE(sum(a.amt), 0) AS total FROM agg a)
  SELECT f.k, f.l, f.nat, f.s, round(COALESCE(a.amt, 0), 2), COALESCE(a.n, 0)::bigint,
         round(CASE WHEN gr.total > 0 THEN COALESCE(a.amt, 0) * 100 / gr.total ELSE 0 END, 2)
  FROM (VALUES
    ('partner', 'Partner Products and Services', 'capital', 1),
    ('land', 'Land Products and Services', 'recovery', 2),
    ('agent', 'Agent Products and Services', 'recovery', 3),
    ('fees', 'Fees and Service Income', 'income', 4),
    ('other_income', 'Other Income', 'income', 5),
    ('capital', 'Share Capital', 'capital', 6)
  ) AS f(k, l, nat, s)
  LEFT JOIN agg a ON a.cat_key = f.k
  CROSS JOIN grand gr
  ORDER BY f.s;
END $function$;

CREATE OR REPLACE FUNCTION public.get_cfo_received_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL, p_search text DEFAULT NULL, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid, transaction_date timestamptz, created_at timestamptz, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_from timestamptz; v_to timestamptz; v_search text := nullif(btrim(p_search), '');
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023'; END IF;
  v_from := (p_from::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   := ((p_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  RETURN QUERY
  WITH f AS (
    SELECT g.id AS gid, g.transaction_date AS tdate, public._cfo_received_category_for(g.category) AS ckey
    FROM public.general_ledger g
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
  ), pg AS (
    SELECT m.gid, m.tdate, m.ckey, m.n FROM m ORDER BY m.tdate DESC, m.gid
    LIMIT least(greatest(COALESCE(p_limit, 50), 1), 1000) OFFSET greatest(COALESCE(p_offset, 0), 0)
  )
  SELECT g.id, g.transaction_date, g.created_at, pg.ckey,
         CASE pg.ckey WHEN 'partner' THEN 'Partner Products and Services' WHEN 'land' THEN 'Land Products and Services'
           WHEN 'agent' THEN 'Agent Products and Services' WHEN 'fees' THEN 'Fees and Service Income'
           WHEN 'other_income' THEN 'Other Income' WHEN 'capital' THEN 'Share Capital' END,
         g.category, round(g.amount, 2), g.description, g.reference_id,
         p.full_name, p.phone, g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END $function$;

GRANT EXECUTE ON FUNCTION public.get_cfo_received_by_category_totals(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cfo_received_by_category_page(date, date, text, text, integer, integer) TO authenticated;