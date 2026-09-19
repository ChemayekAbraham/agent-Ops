CREATE OR REPLACE FUNCTION public.get_sofp_account_detail(
  p_as_at timestamptz,
  p_account_code text,
  p_limit int DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_net numeric := 0;
  v_legs bigint := 0;
  v_cats jsonb := '[]'::jsonb;
  v_txns jsonb := '[]'::jsonb;
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

  CREATE TEMP TABLE IF NOT EXISTS _sofp_acct_legs (
    transaction_group_id uuid,
    ledger_scope text,
    category text,
    source_table text,
    dr numeric,
    cr numeric,
    transaction_date timestamptz
  ) ON COMMIT DROP;
  DELETE FROM _sofp_acct_legs;

  INSERT INTO _sofp_acct_legs
  SELECT l.transaction_group_id, l.ledger_scope, l.category, l.source_table,
         l.dr, l.cr, l.transaction_date
  FROM public.sofp_ledger_legs(p_as_at) l
  WHERE l.account_code = p_account_code;

  SELECT COALESCE(SUM(dr - cr), 0), COUNT(*) INTO v_net, v_legs FROM _sofp_acct_legs;

  SELECT COALESCE(jsonb_agg(x ORDER BY abs_net DESC), '[]'::jsonb)
  INTO v_cats
  FROM (
    SELECT jsonb_build_object(
             'category', category,
             'ledger_scope', ledger_scope,
             'legs', COUNT(*),
             'net', ROUND(SUM(dr - cr), 2)
           ) AS x,
           ABS(SUM(dr - cr)) AS abs_net
    FROM _sofp_acct_legs
    GROUP BY category, ledger_scope
  ) g;

  SELECT COALESCE(jsonb_agg(x ORDER BY tdate DESC), '[]'::jsonb)
  INTO v_txns
  FROM (
    SELECT jsonb_build_object(
             'transaction_group_id', transaction_group_id,
             'transaction_date', MAX(transaction_date),
             'category', MIN(category),
             'source_table', MIN(source_table),
             'net', ROUND(SUM(dr - cr), 2)
           ) AS x,
           MAX(transaction_date) AS tdate
    FROM _sofp_acct_legs
    GROUP BY transaction_group_id
    ORDER BY MAX(transaction_date) DESC
    LIMIT v_limit
  ) t;

  RETURN jsonb_build_object(
    'account_code', p_account_code,
    'as_at', p_as_at,
    'net', ROUND(v_net, 2),
    'legs', v_legs,
    'categories', v_cats,
    'transactions', v_txns,
    'shown', jsonb_array_length(v_txns),
    'truncated', (SELECT COUNT(DISTINCT transaction_group_id) FROM _sofp_acct_legs) > jsonb_array_length(v_txns)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_sofp_account_detail(timestamptz, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sofp_account_detail(timestamptz, text, int) TO authenticated;