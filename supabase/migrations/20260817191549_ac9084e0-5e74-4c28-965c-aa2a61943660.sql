CREATE OR REPLACE FUNCTION public.get_treasury_cash_position(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_a1 numeric := 0;
  v_a5 numeric := 0;
  v_lines jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the treasury cash position';
  END IF;

  WITH legs AS MATERIALIZED (
    SELECT gl.category,
           gl.direction,
           gl.amount,
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
  ), cash AS (
    SELECT account_code, category,
           CASE WHEN direction = debit_when THEN amount ELSE 0 END AS dr,
           CASE WHEN direction = debit_when THEN 0 ELSE amount END AS cr
    FROM legs
    WHERE account_code IN ('A1','A5')
  ), bal AS (
    SELECT account_code, SUM(dr) - SUM(cr) AS net FROM cash GROUP BY 1
  ), by_cat AS (
    SELECT category,
           SUM(dr) AS dr,
           SUM(cr) AS cr,
           COUNT(*) AS entry_count
    FROM cash
    GROUP BY 1
  )
  SELECT
    COALESCE((SELECT net FROM bal WHERE account_code = 'A1'), 0),
    COALESCE((SELECT net FROM bal WHERE account_code = 'A5'), 0),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'category', category,
               'debits', ROUND(dr),
               'credits', ROUND(cr),
               'net', ROUND(dr - cr),
               'entry_count', entry_count
             ) ORDER BY abs(dr - cr) DESC)
      FROM by_cat
    ), '[]'::jsonb)
  INTO v_a1, v_a5, v_lines;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'a1_cash_and_bank', ROUND(v_a1),
    'a5_cash_in_transit', ROUND(v_a5),
    'total_cash', ROUND(v_a1 + v_a5),
    'lines', v_lines,
    'source', 'general_ledger trial balance — accounts A1 + A5 (Balance Sheet basis)'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_treasury_cash_position(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_treasury_cash_position(timestamptz) TO authenticated;