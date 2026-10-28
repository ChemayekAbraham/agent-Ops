CREATE OR REPLACE FUNCTION public._cfo_paid_lunch_correction_ok(p_id uuid, p_group uuid, p_amount numeric, p_ts timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM general_ledger w
    WHERE w.transaction_group_id = p_group AND w.ledger_scope = 'wallet' AND w.direction = 'cash_in'
      AND w.category = 'wallet_deposit' AND w.amount = p_amount
      AND EXISTS (SELECT 1 FROM hr_staff s WHERE s.user_id = w.user_id)
      AND NOT EXISTS (SELECT 1 FROM platform_wallet_corrections c
                      WHERE c.operation = 'debit'
                        AND c.metadata->>'sub_category' IN ('lunch_allowance_reversal:' || w.id::text, 'lunch_allowance_reversal:' || p_id::text))
      AND NOT EXISTS (
        SELECT 1 FROM general_ledger o
        JOIN general_ledger ow ON ow.transaction_group_id = o.transaction_group_id AND ow.ledger_scope = 'wallet'
             AND ow.direction = 'cash_in' AND ow.user_id = w.user_id
        WHERE o.ledger_scope = 'platform' AND o.direction = 'cash_out' AND o.id <> p_id
          AND o.description ILIKE '%lunch allowance%'
          AND o.category IN ('payroll_expense', 'system_balance_correction')
          AND (o.transaction_date AT TIME ZONE 'Africa/Kampala')::date = (p_ts AT TIME ZONE 'Africa/Kampala')::date
          AND (o.category = 'payroll_expense' OR o.transaction_date < p_ts OR (o.transaction_date = p_ts AND o.id < p_id))
      )
  )
$$;
REVOKE ALL ON FUNCTION public._cfo_paid_lunch_correction_ok(uuid, uuid, numeric, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_totals(p_from date, p_to date)
 RETURNS TABLE(category_key text, category_label text, sort_order integer, amount numeric, tx_count bigint, pct numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH legs AS (
    SELECT CASE WHEN g.classification = 'admin_correction' THEN 'budget'
                ELSE public._cfo_paid_category_for(g.category) END AS cat_key, g.amount
    FROM public.general_ledger g
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)))
      AND (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
  ), grand AS (
    SELECT COALESCE(sum(gl.amount), 0) AS total FROM legs gl WHERE gl.cat_key IS NOT NULL
  )
  SELECT f.category_key, f.category_label, f.sort_order,
         round(COALESCE(l.amount, 0), 2) AS amount,
         COALESCE(l.tx_count, 0) AS tx_count,
         round(CASE WHEN gr.total > 0 THEN COALESCE(l.amount, 0) * 100 / gr.total ELSE 0 END, 2) AS pct
  FROM (VALUES
    ('budget', 'Operational Expenses', 1),
    ('landlord_float', 'Landlord Float', 2),
    ('agent', 'Agent Commissions', 3),
    ('partner', 'Partner Products and Services', 4),
    ('landlord', 'Land Products and Services', 5),
    ('marketing', 'Marketing Expenses', 6),
    ('rnd', 'Product Research & Development', 7)
  ) AS f(category_key, category_label, sort_order)
  LEFT JOIN (SELECT cl.cat_key, sum(cl.amount) AS amount, count(*) AS tx_count FROM legs cl WHERE cl.cat_key IS NOT NULL GROUP BY cl.cat_key) l
    ON l.cat_key = f.category_key
  CROSS JOIN grand gr
  ORDER BY f.sort_order;
END
$function$;

CREATE OR REPLACE FUNCTION public.get_cfo_paid_by_category_page(p_from date, p_to date, p_category text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, transaction_date timestamp with time zone, created_at timestamp with time zone, category_key text, category_label text, ledger_category text, amount numeric, description text, reference_id text, counterparty text, counterparty_phone text, approved_by text, source_table text, transaction_group_id uuid, classification text, total_matched bigint)
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
    SELECT g.id AS gid, g.transaction_date AS tdate,
           CASE WHEN g.classification = 'admin_correction' THEN 'budget'
                ELSE public._cfo_paid_category_for(g.category) END AS ckey
    FROM public.general_ledger g
    LEFT JOIN public.profiles sp ON v_search IS NOT NULL AND sp.id = g.user_id
    WHERE g.direction = 'cash_out'
      AND (g.classification IN ('production', 'legacy_real')
           OR (g.classification = 'admin_correction' AND g.category = 'system_balance_correction'
               AND g.ledger_scope = 'platform' AND g.description ILIKE '%automated%lunch allowance%'
               AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)))
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
         COALESCE(cp.full_name, p.full_name), COALESCE(cp.phone, p.phone),
         CASE WHEN cpl.user_id IS NOT NULL AND cpl.user_id IS DISTINCT FROM g.user_id THEN p.full_name END,
         g.source_table, g.transaction_group_id, g.classification, pg.n
  FROM pg JOIN public.general_ledger g ON g.id = pg.gid
  LEFT JOIN LATERAL (
    SELECT x.user_id FROM public.general_ledger x
    WHERE x.transaction_group_id = g.transaction_group_id
      AND x.ledger_scope = 'wallet' AND x.direction = 'cash_in' AND x.user_id IS NOT NULL
    ORDER BY x.amount DESC, x.id
    LIMIT 1
  ) cpl ON true
  LEFT JOIN public.profiles cp ON cp.id = cpl.user_id
  LEFT JOIN public.profiles p ON p.id = g.user_id
  ORDER BY pg.tdate DESC, pg.gid;
END
$function$;