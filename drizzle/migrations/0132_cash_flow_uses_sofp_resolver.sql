-- 1. Add transaction_date to the shared Balance Sheet leg resolver so the
--    Cash Flow can split opening / period / closing on the identical basis.
--    Resolution rules are byte-for-byte unchanged; only the output gains a column.
DROP FUNCTION IF EXISTS public.sofp_ledger_legs(timestamp with time zone);

CREATE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, source_table text,
              account_code text, dr numeric, cr numeric, group_one_sided boolean,
              is_legacy_counterpart boolean, transaction_date timestamp with time zone)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH grp_class AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')
                   OR (gl.classification = 'admin_correction'
                       AND gl.source_table = 'merchant_float_reconciliations')) AS has_reportable
    FROM general_ledger gl
    WHERE gl.transaction_group_id IS NOT NULL
    GROUP BY gl.transaction_group_id
  ), base AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_group_id AS real_gid,
           COALESCE(gl.transaction_group_id, gl.id) AS gid,
           gl.transaction_date AS tdate,
           gl.ledger_scope AS sc,
           gl.category AS cat,
           gl.source_table AS src,
           gl.direction AS dir,
           gl.amount AS amt,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS acct0,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS dw0
    FROM general_ledger gl
    LEFT JOIN grp_class g ON g.transaction_group_id = gl.transaction_group_id
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_date <= p_as_at
      AND CASE
            WHEN gl.transaction_group_id IS NULL
              THEN gl.classification IN ('production','legacy_real')
            ELSE COALESCE(g.has_reportable, false)
          END
  ), shape AS MATERIALIZED (
    SELECT b.gid,
           count(*) AS n_legs,
           count(*) FILTER (WHERE b.sc = 'wallet') AS n_wallet,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'A2') AS n_a2,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'L1') AS n_l1,
           count(*) FILTER (WHERE b.sc = 'platform') AS n_plat,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'system_balance_correction') AS n_plat_sbc,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment')) AS n_repay,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.acct0 = 'R1') AS n_rev,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'landlord_receivable_collected') AS n_land_recv,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'cash_custody_payable') AS n_custody,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'wallet_deposit' AND b.dir = 'cash_out') AS n_bank_receipt,
           sum(CASE WHEN b.dir = 'cash_in' THEN b.amt ELSE -b.amt END) AS raw_net,
           max(b.tdate) AS max_tdate
    FROM base b
    GROUP BY b.gid
  ), adj AS MATERIALIZED (
    SELECT b.real_gid, b.gid, b.tdate, b.sc, b.cat, b.src, b.dir, b.amt, s.raw_net,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'
             AND s.n_a2 > 0 AND b.src = 'merchant_float_reconciliations' THEN 'A8'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'X6'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'A4'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'A1'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'E3'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN 'L1'
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'X4'
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset'
             AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN 'L1'
        ELSE b.acct0
      END AS acct,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN b.dir
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset'
             AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN b.dir
        WHEN b.sc = 'platform'
             AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment',
                           'landlord_receivable_collected')
             AND s.n_a2 > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2'
             AND (s.n_repay > 0 OR s.n_land_recv > 0) THEN b.dir
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_bank_receipt > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_rev > 0 THEN b.dir
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'cash_in'
        ELSE b.dw0
      END AS dw
    FROM base b
    JOIN shape s ON s.gid = b.gid
  ), mapped AS MATERIALIZED (
    SELECT a.real_gid, a.gid, a.tdate, a.sc, a.cat, a.src, a.acct, a.raw_net,
           CASE WHEN a.dir = a.dw THEN a.amt ELSE 0 END AS dr,
           CASE WHEN a.dir = a.dw THEN 0 ELSE a.amt END AS cr
    FROM adj a
  ), one_sided AS (
    SELECT m.gid, SUM(m.dr) - SUM(m.cr) AS resid, MAX(m.tdate) AS tdate
    FROM mapped m
    GROUP BY m.gid
    HAVING abs(MAX(m.raw_net)) > 0.5 AND abs(SUM(m.dr) - SUM(m.cr)) > 0.5
  )
  SELECT m.real_gid, m.sc, m.cat, m.src, m.acct, m.dr, m.cr,
         (o.gid IS NOT NULL) AS group_one_sided,
         false AS is_legacy_counterpart,
         m.tdate
  FROM mapped m
  LEFT JOIN one_sided o ON o.gid = m.gid
  UNION ALL
  SELECT NULL::uuid, 'reconciliation', 'legacy_one_sided_counterpart', NULL, 'E4',
         CASE WHEN o.resid < 0 THEN -o.resid ELSE 0 END,
         CASE WHEN o.resid > 0 THEN  o.resid ELSE 0 END,
         true, true, o.tdate
  FROM one_sided o;
$function$;

-- 2. Cash Flow now reads legs from the same resolver, so its cash accounts carry
--    the identical values the Balance Sheet presents. Cash = A1 + A2.
CREATE OR REPLACE FUNCTION public.get_statement_of_cash_flows(p_from timestamp with time zone, p_to timestamp with time zone)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
), period_legs AS (
  SELECT * FROM legs WHERE transaction_date >= p_from
), cash_groups AS (
  SELECT DISTINCT gid FROM period_legs WHERE account_code IN ('A1','A2') AND gid IS NOT NULL
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

GRANT EXECUTE ON FUNCTION public.get_statement_of_cash_flows(timestamp with time zone, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sofp_ledger_legs(timestamp with time zone) TO authenticated;