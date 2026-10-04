CREATE OR REPLACE FUNCTION public.get_statement_of_cash_flows(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH resolved AS (
  SELECT gl.transaction_group_id AS gid,
         gl.transaction_date,
         gl.category,
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
    AND gl.transaction_date <= p_to
), legs AS (
  SELECT gid, transaction_date, category, account_code,
         CASE WHEN direction = debit_when THEN amount ELSE 0 END AS dr,
         CASE WHEN direction = debit_when THEN 0 ELSE amount END AS cr
  FROM resolved
), cash_bal AS (
  SELECT COALESCE(SUM(CASE WHEN transaction_date < p_from THEN dr - cr ELSE 0 END), 0) AS opening,
         COALESCE(SUM(dr - cr), 0)                                                     AS closing,
         COALESCE(SUM(CASE WHEN transaction_date >= p_from THEN dr - cr ELSE 0 END), 0) AS period_net
  FROM legs
  WHERE account_code IN ('A1','A2')
), period_legs AS (
  SELECT * FROM legs WHERE transaction_date >= p_from
), cash_groups AS (
  SELECT DISTINCT gid FROM period_legs WHERE account_code IN ('A1','A2')
), counterparts AS (
  SELECT pl.account_code, pl.category, SUM(pl.cr - pl.dr) AS cash_effect
  FROM period_legs pl
  JOIN cash_groups cg ON cg.gid = pl.gid
  WHERE pl.account_code NOT IN ('A1','A2')
  GROUP BY 1, 2
), mapped AS (
  SELECT c.cash_effect,
         COALESCE(m.section, 'operating')                         AS section,
         COALESCE(m.group_label, 'Other Operating Activities')    AS group_label,
         COALESCE(m.group_sort, 90)                               AS group_sort,
         COALESCE(m.line_label, 'Unclassified ledger movements')  AS line_label,
         COALESCE(m.line_sort, 950)                               AS line_sort
  FROM counterparts c
  LEFT JOIN LATERAL (
    SELECT m2.* FROM cash_flow_line_map m2
    WHERE m2.display_only = false
      AND (m2.account_code IS NULL OR m2.account_code = c.account_code)
      AND (m2.category IS NULL OR m2.category = c.category)
    ORDER BY (m2.account_code IS NOT NULL)::int + (m2.category IS NOT NULL)::int DESC,
             (m2.category IS NOT NULL)::int DESC
    LIMIT 1
  ) m ON true
), display_rows AS (
  SELECT 0::numeric AS cash_effect, section, group_label, group_sort, line_label, line_sort
  FROM cash_flow_line_map
), all_rows AS (
  SELECT * FROM mapped
  UNION ALL
  SELECT * FROM display_rows
), lines AS (
  SELECT section, group_label, group_sort, line_label,
         MIN(line_sort) AS line_sort,
         SUM(cash_effect) AS amount
  FROM all_rows
  GROUP BY section, group_label, group_sort, line_label
), residual AS (
  SELECT (SELECT period_net FROM cash_bal) - COALESCE((SELECT SUM(amount) FROM lines), 0) AS amt
), lines_final AS (
  SELECT * FROM lines
  UNION ALL
  SELECT 'operating', 'Other Operating Activities', 60,
         'Unreconciled single-sided historic postings', 900, (SELECT amt FROM residual)
  WHERE ABS((SELECT amt FROM residual)) > 0.005
), grouped AS (
  SELECT section, group_label, group_sort,
         SUM(amount) AS group_total,
         jsonb_agg(jsonb_build_object('label', line_label, 'amount', ROUND(amount, 2))
                   ORDER BY line_sort, line_label) AS lines
  FROM lines_final
  GROUP BY section, group_label, group_sort
), sections AS (
  SELECT section,
         SUM(group_total) AS section_total,
         jsonb_agg(jsonb_build_object(
           'label', group_label,
           'total', ROUND(group_total, 2),
           'lines', lines
         ) ORDER BY group_sort, group_label) AS groups
  FROM grouped
  GROUP BY section
)
SELECT jsonb_build_object(
  'from', p_from,
  'to', p_to,
  'currency', 'UGX',
  'cash_definition', 'Cash and cash equivalents = Cash and Bank Balances (A1) plus Cash at Hand — Float with Agents (A2). Transfers between the two cash accounts are eliminated.',
  'operating', COALESCE((SELECT jsonb_build_object('total', ROUND(section_total,2), 'groups', groups) FROM sections WHERE section='operating'),
                        jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
  'investing', COALESCE((SELECT jsonb_build_object('total', ROUND(section_total,2), 'groups', groups) FROM sections WHERE section='investing'),
                        jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
  'financing', COALESCE((SELECT jsonb_build_object('total', ROUND(section_total,2), 'groups', groups) FROM sections WHERE section='financing'),
                        jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
  'exchange_rate_effect', 0,
  'net_change', ROUND((SELECT period_net FROM cash_bal), 2),
  'opening_cash', ROUND((SELECT opening FROM cash_bal), 2),
  'closing_cash', ROUND((SELECT closing FROM cash_bal), 2),
  'unreconciled_residual', ROUND((SELECT amt FROM residual), 2),
  'reconciles', ABS(((SELECT opening FROM cash_bal) + (SELECT period_net FROM cash_bal))
                    - (SELECT closing FROM cash_bal)) < 0.01
);
$$;

REVOKE ALL ON FUNCTION public.get_statement_of_cash_flows(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_statement_of_cash_flows(timestamptz, timestamptz) TO authenticated, service_role;