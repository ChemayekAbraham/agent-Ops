-- Treasury cash position reports the Landlord Float Pool (checklist step 10).
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md §7 · Decision D7 (confirmed
-- 2026-09-29): free cash + pool + total.
--
-- Pool money is still Welile's cash, but it is ring-fenced for landlords. A
-- reserve moves it out of A1 into A21/A22, so the EXISTING figures —
-- a1_cash_and_bank, total_cash, available_company_cash — become FREE cash
-- automatically, and drop by whatever sits in the pool. That is the intended
-- reading: pool money is not free to spend on operations.
--
-- Every existing key keeps its name, meaning (A1 + A5) and shape, and `lines`
-- still lists only A1/A5 categories, so no screen changes shape. New keys:
--   landlord_pool_self_support     A21
--   landlord_pool_company_managed  A22
--   landlord_pool_total            A21 + A22
--   total_treasury_incl_pool       A1 + A5 + A21 + A22
--
-- Brief finance before the pool is switched on: free cash will diverge from
-- bank statements by exactly landlord_pool_total.

CREATE OR REPLACE FUNCTION public.get_treasury_cash_position(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_a1 numeric := 0;
  v_a5 numeric := 0;
  v_a21 numeric := 0;  -- Landlord Float Pool — Self-Support
  v_a22 numeric := 0;  -- Landlord Float Pool — Company-Managed
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
    WHERE (gl.classification IN ('production','legacy_real')
             OR (gl.classification = 'admin_correction'
                 AND gl.source_table = 'merchant_float_reconciliations'))
      AND gl.transaction_date <= p_as_at
  ), cash AS (
    SELECT account_code, category,
           CASE WHEN direction = debit_when THEN amount ELSE 0 END AS dr,
           CASE WHEN direction = debit_when THEN 0 ELSE amount END AS cr
    FROM legs
    WHERE account_code IN ('A1','A5','A21','A22')
  ), bal AS (
    SELECT account_code, SUM(dr) - SUM(cr) AS net FROM cash GROUP BY 1
  ), by_cat AS (
    SELECT category,
           SUM(dr) AS dr,
           SUM(cr) AS cr,
           COUNT(*) AS entry_count
    FROM cash
    WHERE account_code IN ('A1','A5')
    GROUP BY 1
  )
  SELECT
    COALESCE((SELECT net FROM bal WHERE account_code = 'A1'), 0),
    COALESCE((SELECT net FROM bal WHERE account_code = 'A5'), 0),
    COALESCE((SELECT net FROM bal WHERE account_code = 'A21'), 0),
    COALESCE((SELECT net FROM bal WHERE account_code = 'A22'), 0),
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
  INTO v_a1, v_a5, v_a21, v_a22, v_lines;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'a1_cash_and_bank', ROUND(v_a1),
    'a5_cash_in_transit', ROUND(v_a5),
    'total_cash', ROUND(v_a1 + v_a5),
    'available_company_cash', ROUND(v_a1),
    'custody_not_confirmed_banked', ROUND(v_a5),
    'custody_caption', 'Cash in Custody — Not Yet Confirmed Banked',
    'landlord_pool_self_support', ROUND(v_a21),
    'landlord_pool_company_managed', ROUND(v_a22),
    'landlord_pool_total', ROUND(v_a21 + v_a22),
    'total_treasury_incl_pool', ROUND(v_a1 + v_a5 + v_a21 + v_a22),
    'lines', v_lines,
    'source', 'general_ledger trial balance — A1 Cash and Bank (available) and A5 cash in custody, not yet confirmed banked; Landlord Float Pool A21/A22 reported separately'
  );
END;
$function$;
