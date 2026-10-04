CREATE OR REPLACE FUNCTION public.get_sofp_account_detail(p_as_at timestamp with time zone, p_account_code text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH legs AS MATERIALIZED (
    SELECT l.transaction_group_id, l.ledger_scope, l.category, l.source_table,
           l.dr, l.cr, l.transaction_date
    FROM public.sofp_ledger_legs(p_as_at) l
    WHERE l.account_code = p_account_code
  ), totals AS (
    SELECT COALESCE(SUM(dr - cr), 0) AS net,
           COUNT(*) AS legs,
           COUNT(DISTINCT transaction_group_id) AS groups
    FROM legs
  ), cats AS (
    SELECT jsonb_build_object(
             'category', category,
             'ledger_scope', ledger_scope,
             'legs', COUNT(*),
             'net', ROUND(SUM(dr - cr), 2)
           ) AS x,
           ABS(SUM(dr - cr)) AS abs_net
    FROM legs
    GROUP BY category, ledger_scope
  ), cats_agg AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY abs_net DESC), '[]'::jsonb) AS v FROM cats
  ), txns AS (
    SELECT jsonb_build_object(
             'transaction_group_id', transaction_group_id,
             'transaction_date', MAX(transaction_date),
             'category', MIN(category),
             'source_table', MIN(source_table),
             'net', ROUND(SUM(dr - cr), 2)
           ) AS x,
           MAX(transaction_date) AS tdate
    FROM legs
    GROUP BY transaction_group_id
    ORDER BY MAX(transaction_date) DESC
    LIMIT v_limit
  ), txns_agg AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY tdate DESC), '[]'::jsonb) AS v FROM txns
  )
  SELECT jsonb_build_object(
           'account_code', p_account_code,
           'as_at', p_as_at,
           'net', ROUND(t.net, 2),
           'legs', t.legs,
           'categories', c.v,
           'transactions', x.v,
           'shown', jsonb_array_length(x.v),
           'truncated', t.groups > jsonb_array_length(x.v)
         )
  INTO v_result
  FROM totals t, cats_agg c, txns_agg x;

  RETURN v_result;
END;
$function$;