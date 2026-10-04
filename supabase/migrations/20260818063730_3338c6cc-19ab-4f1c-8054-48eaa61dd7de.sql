CREATE OR REPLACE FUNCTION public.get_treasury_cash_transactions(
  p_category text,
  p_as_at timestamptz DEFAULT now(),
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
  v_total_count bigint := 0;
  v_net numeric := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view treasury cash transactions';
  END IF;

  WITH legs AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_date,
           gl.category,
           gl.direction,
           gl.amount,
           gl.description,
           gl.reference_id,
           gl.classification,
           gl.linked_party,
           gl.source_table,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS account_code,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS debit_when
    FROM general_ledger gl
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.classification IN ('production','legacy_real')
      AND gl.transaction_date <= p_as_at
      AND gl.category = p_category
  ), cash AS (
    SELECT l.*,
           CASE WHEN l.direction = l.debit_when THEN l.amount ELSE -l.amount END AS signed_amount
    FROM legs l
    WHERE l.account_code IN ('A1','A5')
  )
  SELECT
    COALESCE(count(*), 0),
    COALESCE(SUM(signed_amount), 0)
  INTO v_total_count, v_net
  FROM cash;

  WITH legs AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_date,
           gl.category,
           gl.direction,
           gl.amount,
           gl.description,
           gl.reference_id,
           gl.classification,
           gl.linked_party,
           gl.source_table,
           COALESCE(mb.account_code, mw.account_code, 'A9') AS account_code,
           COALESCE(mb.debit_when, mw.debit_when, 'cash_in') AS debit_when
    FROM general_ledger gl
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.classification IN ('production','legacy_real')
      AND gl.transaction_date <= p_as_at
      AND gl.category = p_category
  ), cash AS (
    SELECT l.*,
           CASE WHEN l.direction = l.debit_when THEN l.amount ELSE -l.amount END AS signed_amount
    FROM legs l
    WHERE l.account_code IN ('A1','A5')
    ORDER BY l.transaction_date DESC
    LIMIT GREATEST(1, LEAST(p_limit, 200)) OFFSET GREATEST(0, p_offset)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id,
           'transaction_date', transaction_date,
           'reference', COALESCE(reference_id, ''),
           'description', COALESCE(description, ''),
           'amount', ROUND(signed_amount),
           'account_code', account_code,
           'direction', CASE WHEN signed_amount >= 0 THEN 'in' ELSE 'out' END,
           'status', classification,
           'linked_party', COALESCE(linked_party, ''),
           'source_table', COALESCE(source_table, '')
         ) ORDER BY transaction_date DESC), '[]'::jsonb)
  INTO v_rows
  FROM cash;

  RETURN jsonb_build_object(
    'category', p_category,
    'as_at', p_as_at,
    'total_count', v_total_count,
    'net_amount', ROUND(v_net),
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_treasury_cash_transactions(text, timestamptz, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.get_treasury_cash_transactions(text, timestamptz, int, int) TO authenticated;