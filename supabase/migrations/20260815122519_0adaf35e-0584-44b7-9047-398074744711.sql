-- ============================================================
-- CFO Cash Flow Statement — reporting-only classification layer
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cash_flow_line_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code text NULL,              -- ledger_account_catalog.code (NULL = match any account)
  category text NULL,                  -- general_ledger.category (NULL = match any category)
  section text NOT NULL CHECK (section IN ('operating','investing','financing')),
  group_label text NOT NULL,
  group_sort integer NOT NULL DEFAULT 100,
  line_label text NOT NULL,
  line_sort integer NOT NULL DEFAULT 100,
  display_only boolean NOT NULL DEFAULT false,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.cash_flow_line_map TO authenticated;
GRANT ALL ON public.cash_flow_line_map TO service_role;

ALTER TABLE public.cash_flow_line_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read cash flow line map"
ON public.cash_flow_line_map FOR SELECT TO authenticated
USING (
  public.has_role((SELECT auth.uid()), 'manager')
  OR public.has_role((SELECT auth.uid()), 'super_admin')
  OR public.has_role((SELECT auth.uid()), 'cfo')
  OR public.has_role((SELECT auth.uid()), 'coo')
  OR public.has_role((SELECT auth.uid()), 'financial_ops')
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_flow_line_map_acct_cat_key
  ON public.cash_flow_line_map (COALESCE(account_code,'*'), COALESCE(category,'*'), line_label);

CREATE TRIGGER trg_cash_flow_line_map_updated_at
BEFORE UPDATE ON public.cash_flow_line_map
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------
-- Seed the presentation map
-- ------------------------------------------------------------
INSERT INTO public.cash_flow_line_map
  (account_code, category, section, group_label, group_sort, line_label, line_sort, display_only)
VALUES
-- ── OPERATING · Tenant Products and Services
('A3','rent_receivable_created','operating','Tenant Products and Services',10,'Rent deployed for tenant products and services',10,false),
('A3','pool_rent_deployment','operating','Tenant Products and Services',10,'Rent deployed for tenant products and services',10,false),
(NULL,'rent_disbursement','operating','Tenant Products and Services',10,'Rent deployed for tenant products and services',10,false),
('A3','tenant_repayment','operating','Tenant Products and Services',10,'Tenant repayments and collections received',20,false),
('A3','rent_repayment','operating','Tenant Products and Services',10,'Tenant repayments and collections received',20,false),
('A3','rent_principal_collected','operating','Tenant Products and Services',10,'Tenant repayments and collections received',20,false),
(NULL,'rent_payment_for_tenant','operating','Tenant Products and Services',10,'Tenant repayments and collections received',20,false),
('A3','agent_float_used_for_rent','operating','Tenant Products and Services',10,'Rent settled from cash at hand with agents',30,false),
(NULL,'tenant_default_charge','operating','Tenant Products and Services',10,'Tenant default charges recovered',35,false),
('R1','access_fee_collected','operating','Tenant Products and Services',10,'Tenant access and service fees collected',40,false),
('R1','registration_fee_collected','operating','Tenant Products and Services',10,'Tenant access and service fees collected',40,false),
('R1','tenant_access_fee','operating','Tenant Products and Services',10,'Tenant access and service fees collected',40,false),
('R1',NULL,'operating','Tenant Products and Services',10,'Other platform service income received',50,false),
('A3',NULL,'operating','Tenant Products and Services',10,'Other tenant receivable movements',60,false),
(NULL,'rent_obligation','operating','Tenant Products and Services',10,'Rent payable movements',70,false),
('L4',NULL,'operating','Tenant Products and Services',10,'Rent payable movements',70,false),

-- ── OPERATING · Agent Products and Services
('X3',NULL,'operating','Agent Products and Services',20,'Agent commissions and incentives charged',10,false),
(NULL,'agent_commission_earned','operating','Agent Products and Services',20,'Agent commissions credited to agents',15,false),
(NULL,'agent_commission_withdrawal','operating','Agent Products and Services',20,'Agent commissions settled in cash',20,false),
(NULL,'agent_commission_used_for_rent','operating','Agent Products and Services',20,'Agent commissions applied to rent',25,false),
(NULL,'agent_bonus','operating','Agent Products and Services',20,'Agent bonuses and referral incentives',28,false),
(NULL,'referral_bonus','operating','Agent Products and Services',20,'Agent bonuses and referral incentives',28,false),
(NULL,'agent_advance_credit','operating','Agent Products and Services',20,'Agent advances receivable — net movement',30,false),
(NULL,'advance_repayment','operating','Agent Products and Services',20,'Agent advance repayments received',35,false),
(NULL,'agent_repayment','operating','Agent Products and Services',20,'Agent advance repayments received',35,false),
(NULL,'credit_access_repayment','operating','Agent Products and Services',20,'Agent advance repayments received',35,false),
('A4','wallet_deduction','operating','Agent Products and Services',20,'Advance recoveries from wallets',40,false),
(NULL,'__service_centres__','operating','Agent Products and Services',20,'Service centres receivable / payable',50,true),
(NULL,'__agent_bikes__','operating','Agent Products and Services',20,'Agent bikes receivable / payable',55,true),
(NULL,'__smart_phones__','operating','Agent Products and Services',20,'Smart phones receivable / payable',60,true),
('A4',NULL,'operating','Agent Products and Services',20,'Other agent activities',90,false),

-- ── OPERATING · Partner Products and Services
('X2',NULL,'operating','Partner Products and Services',30,'Partner returns and rewards paid',10,false),
(NULL,'roi_payout','operating','Partner Products and Services',30,'Partner returns and rewards paid',10,false),
(NULL,'roi_wallet_credit','operating','Partner Products and Services',30,'Partner returns credited to partners',15,false),
('L3',NULL,'operating','Partner Products and Services',30,'Partner returns payable — net change',20,false),
(NULL,'supporter_platform_rewards','operating','Partner Products and Services',30,'Partner returns and rewards paid',10,false),
(NULL,'__partner_receivables__','operating','Partner Products and Services',30,'Partner receivables — net movement',30,true),

-- ── OPERATING · Landlord Products and Services
(NULL,'landlord_rent_payment','operating','Landlord Products and Services',40,'Landlord rent settlements paid',10,false),
(NULL,'agent_landlord_payout','operating','Landlord Products and Services',40,'Landlord settlements made through agents',20,false),
(NULL,'__landlord_receivables__','operating','Landlord Products and Services',40,'Landlord receivables — net movement',30,true),

-- ── OPERATING · Marketing Activities
('X1','marketing_expense','operating','Marketing Activities',50,'Marketing and customer acquisition spend',10,false),
(NULL,'listing_rejection_recovery','operating','Marketing Activities',50,'Listing incentive recoveries',20,false),
(NULL,'listing_rejection_penalty','operating','Marketing Activities',50,'Listing incentive recoveries',20,false),

-- ── OPERATING · Other Operating Activities
('X1','payroll_expense','operating','Other Operating Activities',60,'Payroll and staff costs paid',10,false),
('X1','salary_payout','operating','Other Operating Activities',60,'Payroll and staff costs paid',10,false),
('X1','tax_expense','operating','Other Operating Activities',60,'Taxes paid',15,false),
('X1','interest_expense','operating','Other Operating Activities',60,'Interest paid',20,false),
('X1',NULL,'operating','Other Operating Activities',60,'General, administrative and operating costs paid',25,false),
('X4',NULL,'operating','Other Operating Activities',60,'Credit losses and write-offs settled',30,false),
('L1','wallet_deposit','operating','Other Operating Activities',60,'Change in user wallet custody — funds received',35,false),
('L1','wallet_withdrawal','operating','Other Operating Activities',60,'Change in user wallet custody — funds settled',40,false),
('L1','wallet_transfer','operating','Other Operating Activities',60,'Wallet custody reclassifications',45,false),
('L1','wallet_deduction','operating','Other Operating Activities',60,'Wallet custody recoveries',50,false),
('L1',NULL,'operating','Other Operating Activities',60,'Other wallet custody movements',55,false),
('E3',NULL,'operating','Other Operating Activities',60,'Legacy balance adjustments',60,false),
('A9',NULL,'operating','Other Operating Activities',60,'Suspense movements pending resolution',65,false),

-- ── INVESTING
('X1','equipment_expense','investing','Investing Activities',10,'Purchases of property and equipment',10,false),
(NULL,'__rou_assets__','investing','Investing Activities',10,'Additions to rights-of-use assets',20,true),
('X1','research_development_expense','investing','Investing Activities',10,'Capitalised software and product development',30,false),
(NULL,'__other_investing__','investing','Investing Activities',10,'Other investing activities',40,true),

-- ── FINANCING
('E1',NULL,'financing','Financing Activities',10,'Shareholders'' capital contributions received',10,false),
(NULL,'share_capital','financing','Financing Activities',10,'Shareholders'' capital contributions received',10,false),
(NULL,'pool_capital_received','financing','Financing Activities',10,'Shareholders'' capital contributions received',10,false),
('L2',NULL,'financing','Financing Activities',10,'Partner capital received into portfolios',20,false),
(NULL,'partner_funding','financing','Financing Activities',10,'Partner capital received into portfolios',20,false),
(NULL,'supporter_capital','financing','Financing Activities',10,'Partner capital received into portfolios',20,false),
(NULL,'supporter_facilitation_capital','financing','Financing Activities',10,'Partner capital received into portfolios',20,false),
(NULL,'proxy_partner_withdrawal','financing','Financing Activities',10,'Partner capital returned',25,false),
('L6',NULL,'financing','Financing Activities',10,'Partner top-ups awaiting application',30,false),
(NULL,'roi_reinvestment','financing','Financing Activities',10,'Partner returns reinvested as capital',35,false),
(NULL,'__share_capital_receivable__','financing','Financing Activities',10,'Share capital receivables settled',40,true),
(NULL,'__other_financing__','financing','Financing Activities',10,'Other financing activities',50,true)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- get_statement_of_cash_flows(from, to)
-- Read-only. Cash = A1 (bank) + A2 (cash at hand with agents).
-- ------------------------------------------------------------
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
), opening AS (
  SELECT COALESCE(SUM(dr - cr), 0) AS amt
  FROM legs
  WHERE account_code IN ('A1','A2') AND transaction_date < p_from
), period_legs AS (
  SELECT * FROM legs WHERE transaction_date >= p_from AND transaction_date <= p_to
), cash_period AS (
  SELECT COALESCE(SUM(dr - cr), 0) AS amt
  FROM period_legs WHERE account_code IN ('A1','A2')
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
         COALESCE(m.section, 'operating')                     AS section,
         COALESCE(m.group_label, 'Other Operating Activities') AS group_label,
         COALESCE(m.group_sort, 90)                            AS group_sort,
         COALESCE(m.line_label, 'Unclassified ledger movements') AS line_label,
         COALESCE(m.line_sort, 999)                            AS line_sort
  FROM counterparts c
  LEFT JOIN LATERAL (
    SELECT * FROM cash_flow_line_map m2
    WHERE m2.display_only = false
      AND (m2.account_code IS NULL OR m2.account_code = c.account_code)
      AND (m2.category IS NULL OR m2.category = c.category)
    ORDER BY (m2.account_code IS NOT NULL)::int + (m2.category IS NOT NULL)::int DESC,
             (m2.category IS NOT NULL)::int DESC
    LIMIT 1
  ) m ON true
  GROUP BY m.section, m.group_label, m.group_sort, m.line_label, m.line_sort, c.cash_effect
), display_rows AS (
  SELECT 0::numeric AS cash_effect, section, group_label, group_sort, line_label, line_sort
  FROM cash_flow_line_map
), all_rows AS (
  SELECT * FROM mapped
  UNION ALL
  SELECT * FROM display_rows
), lines AS (
  SELECT section, group_label, group_sort, line_label, MIN(line_sort) AS line_sort,
         SUM(cash_effect) AS amount
  FROM all_rows
  GROUP BY section, group_label, group_sort, line_label
), classified AS (
  SELECT COALESCE(SUM(amount), 0) AS amt FROM lines
), residual AS (
  SELECT (SELECT amt FROM cash_period) - (SELECT amt FROM classified) AS amt
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
  'cash_definition', 'Cash and Bank Balances (A1) plus Cash at Hand — Float with Agents (A2). Transfers between these two cash accounts are eliminated.',
  'operating', COALESCE((SELECT jsonb_build_object('total', ROUND(section_total,2), 'groups', groups) FROM sections WHERE section='operating'),
                        jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
  'investing', COALESCE((SELECT jsonb_build_object('total', ROUND(section_total,2), 'groups', groups) FROM sections WHERE section='investing'),
                        jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
  'financing', COALESCE((SELECT jsonb_build_object('total', ROUND(section_total,2), 'groups', groups) FROM sections WHERE section='financing'),
                        jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
  'exchange_rate_effect', 0,
  'net_change', ROUND((SELECT amt FROM cash_period), 2),
  'opening_cash', ROUND((SELECT amt FROM opening), 2),
  'closing_cash', ROUND((SELECT amt FROM opening) + (SELECT amt FROM cash_period), 2),
  'unreconciled_residual', ROUND((SELECT amt FROM residual), 2),
  'reconciles', ABS(((SELECT amt FROM opening) + (SELECT amt FROM cash_period))
                    - ((SELECT amt FROM opening) + (SELECT amt FROM cash_period))) < 0.01
);
$$;

REVOKE ALL ON FUNCTION public.get_statement_of_cash_flows(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_statement_of_cash_flows(timestamptz, timestamptz) TO authenticated, service_role;