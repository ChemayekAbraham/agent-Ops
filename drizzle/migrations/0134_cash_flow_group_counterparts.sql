-- Counterpart legs of a cash transaction can carry a different transaction_date
-- from the cash leg itself (91 wallet-deposit groups do). Filtering counterparts
-- by date therefore stranded genuine movements in the residual line. Attribute
-- every counterpart leg of a group whose cash leg falls in the period.
CREATE OR REPLACE FUNCTION public.get_statement_of_cash_flows(p_from timestamp with time zone, p_to timestamp with time zone)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
WITH legs AS MATERIALIZED (
  SELECT l.transaction_group_id AS gid,
         l.transaction_date,
         l.category,
         l.account_code,
         l.dr,
         l.cr
  FROM sofp_ledger_legs(p_to) l
), cash_bal AS (
  SELECT COALESCE(SUM(CASE WHEN transaction_date < p_from THEN dr - cr ELSE 0 END), 0) AS opening,
         COALESCE(SUM(dr - cr), 0)                                                     AS closing,
         COALESCE(SUM(CASE WHEN transaction_date >= p_from THEN dr - cr ELSE 0 END), 0) AS period_net
  FROM legs
  WHERE account_code IN ('A1','A2')
), cash_by_account AS (
  SELECT l.account_code,
         c.label,
         COALESCE(SUM(CASE WHEN l.transaction_date < p_from THEN l.dr - l.cr ELSE 0 END), 0) AS opening,
         COALESCE(SUM(l.dr - l.cr), 0) AS closing
  FROM legs l
  JOIN ledger_account_catalog c ON c.code = l.account_code
  WHERE l.account_code IN ('A1','A2')
  GROUP BY l.account_code, c.label
), cash_groups AS (
  SELECT DISTINCT gid
  FROM legs
  WHERE transaction_date >= p_from
    AND account_code IN ('A1','A2')
    AND gid IS NOT NULL
), counterparts AS (
  SELECT pl.account_code, pl.category, SUM(pl.cr - pl.dr) AS cash_effect
  FROM legs pl
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
  'cash_definition', 'Cash and cash equivalents = Cash and Bank Balances (A1) plus Cash at Hand — Float with Agents (A2), resolved through the same ledger resolver the Statement of Financial Position uses (sofp_ledger_legs), each carried at its signed trial-balance value (debits less credits). Cash in Transit (A5) and the Agent and Merchant Float Cycle Control account (A8) are not cash equivalents and are presented as counterpart movements, consistent with the Balance Sheet.',
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
  'cash_accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'code', account_code,
                                'label', label,
                                'opening', ROUND(opening, 2),
                                'closing', ROUND(closing, 2)) ORDER BY account_code)
                             FROM cash_by_account), '[]'::jsonb),
  'balance_sheet_cash', ROUND(COALESCE((SELECT SUM(closing) FROM cash_by_account), 0), 2),
  'ties_to_balance_sheet', ABS((SELECT closing FROM cash_bal)
                               - COALESCE((SELECT SUM(closing) FROM cash_by_account), 0)) < 0.01,
  'unreconciled_residual', ROUND((SELECT amt FROM residual), 2),
  'reconciles', ABS(((SELECT opening FROM cash_bal) + (SELECT period_net FROM cash_bal))
                    - (SELECT closing FROM cash_bal)) < 0.01
);
$function$;