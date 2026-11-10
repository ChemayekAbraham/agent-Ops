-- Financial reporting engine (Phase C, reporting only).
--
-- CFO repair programme, 9-10 Nov 2026: "fixing accounting, not moving money". This migration adds READ-ONLY
-- reporting functions and three small configuration tables. It posts nothing, changes no balance and calls no
-- wallet, payment, payout, recovery or ledger-posting function.
--
--   fin_pnl_lines          category -> Income Statement line (labelling only; the account decides the section)
--   fin_cash_flow_map      counterpart account/category -> Cash Flow line (inflow and outflow labels)
--   fin_cash_accounts      which ledger accounts are "cash and cash equivalents" (PROVISIONAL, CFO decisions D2/D3)
--
--   fin_income_statement(from, to)  revenue (R) and expense (X) accounts only, from sofp_ledger_legs; monthly columns
--   fin_balance_sheet(as_at)        get_statement_of_financial_position + sub-ledger ties
--   fin_cash_flow(from, to)         direct method on the cash accounts above; internal transfers eliminated;
--                                   NO balancing line: any unexplained difference is reported with its groups
--   fin_controls(as_at)             read-only accounting health checks for the CFO
--
-- Replaces for reporting: the browser Income Statement (useFinancialStatements.ts category lists) and
-- get_statement_of_cash_flows__impl (cash = A1 + A2 with a residual line). Existing functions are left in place.
-- Historical treatment: legacy resolver output (sofp_ledger_legs) is read as is; no history is rewritten.
-- Rollback: supabase/rollbacks/20261110090000_fin_reporting_engine.rollback.sql

-- ── Access helper (closed: only the owner and the functions below use it) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fin_can_view()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
       public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'financial_ops')
    OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'cto'))
$$;
REVOKE ALL ON FUNCTION public._fin_can_view() FROM PUBLIC;
-- Used by the RLS read policies below, so a signed-in session must be able to call it (it only answers yes/no).
GRANT EXECUTE ON FUNCTION public._fin_can_view() TO authenticated, service_role;

-- ── Configuration tables ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_pnl_lines (
  id          serial PRIMARY KEY,
  account_code text NOT NULL,
  category     text,                -- NULL = default line for the account
  section      text NOT NULL CHECK (section IN ('revenue','cost_of_revenue','operating_expense','other','tax')),
  line_label   text NOT NULL,
  sort         integer NOT NULL DEFAULT 500,
  flag         text,                -- shown to the CFO next to the line
  UNIQUE NULLS NOT DISTINCT (account_code, category)
);

CREATE TABLE IF NOT EXISTS public.fin_cash_flow_map (
  id           serial PRIMARY KEY,
  account_code text,                -- counterpart account (NULL = any)
  category     text,                -- counterpart category (NULL = any)
  section      text NOT NULL CHECK (section IN ('operating','investing','financing')),
  group_label  text NOT NULL,
  group_sort   integer NOT NULL DEFAULT 50,
  line_in      text NOT NULL,       -- label when the counterpart brings cash in
  line_out     text NOT NULL,       -- label when the counterpart takes cash out
  sort         integer NOT NULL DEFAULT 500,
  UNIQUE NULLS NOT DISTINCT (account_code, category)
);

CREATE TABLE IF NOT EXISTS public.fin_cash_accounts (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  restricted boolean NOT NULL DEFAULT false,
  included   boolean NOT NULL DEFAULT true,
  note       text
);

ALTER TABLE public.fin_pnl_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_cash_flow_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_cash_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fin_pnl_lines_read ON public.fin_pnl_lines;
CREATE POLICY fin_pnl_lines_read ON public.fin_pnl_lines FOR SELECT TO authenticated USING ((SELECT public._fin_can_view()));
DROP POLICY IF EXISTS fin_cash_flow_map_read ON public.fin_cash_flow_map;
CREATE POLICY fin_cash_flow_map_read ON public.fin_cash_flow_map FOR SELECT TO authenticated USING ((SELECT public._fin_can_view()));
DROP POLICY IF EXISTS fin_cash_accounts_read ON public.fin_cash_accounts;
CREATE POLICY fin_cash_accounts_read ON public.fin_cash_accounts FOR SELECT TO authenticated USING ((SELECT public._fin_can_view()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.fin_pnl_lines;
CREATE POLICY mfa_required_for_staff ON public.fin_pnl_lines AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.fin_cash_flow_map;
CREATE POLICY mfa_required_for_staff ON public.fin_cash_flow_map AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.fin_cash_accounts;
CREATE POLICY mfa_required_for_staff ON public.fin_cash_accounts AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

REVOKE ALL ON public.fin_pnl_lines, public.fin_cash_flow_map, public.fin_cash_accounts FROM anon, authenticated;
GRANT SELECT ON public.fin_pnl_lines, public.fin_cash_flow_map, public.fin_cash_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_pnl_lines, public.fin_cash_flow_map, public.fin_cash_accounts TO service_role;

-- Seed: Income Statement lines (labels only; amounts always come from the account)
INSERT INTO public.fin_pnl_lines (account_code, category, section, line_label, sort, flag) VALUES
  ('R1', NULL,                           'revenue', 'Other revenue',                                 190, NULL),
  ('R1', 'access_fee_collected',         'revenue', 'Rent Plan access fees',                         110, NULL),
  ('R1', 'tenant_access_fee',            'revenue', 'Rent Plan access fees',                         110, NULL),
  ('R1', 'registration_fee_collected',   'revenue', 'Rent Plan registration fees',                   120, NULL),
  ('R1', 'platform_fee_collected',       'revenue', 'Platform fee on repayments (four-part split)',  130, NULL),
  ('R1', 'treasury_net_revenue',         'revenue', 'Platform fee on repayments (four-part split)',  130, NULL),
  ('R1', 'merchandise_revenue',          'revenue', 'Merchandise revenue',                           150, NULL),
  ('R1', 'merchandise_payment_retained', 'revenue', 'Merchandise revenue',                           150, NULL),
  ('R1', 'listing_rejection_recovery',   'revenue', 'Listing recoveries',                            160, NULL),
  ('R1', 'special_advance_fee_revenue',  'revenue', 'Advance fees',                                  140, NULL),
  ('R2', NULL,                           'revenue', 'Advance fees',                                  140, NULL),
  ('R3', NULL,                           'revenue', 'Other revenue',                                 190, NULL),
  ('X2', NULL,                           'cost_of_revenue', 'Supporter Returns',                     210, NULL),
  ('X3', NULL,                           'cost_of_revenue', 'Agent commissions',                     220, NULL),
  ('X1', NULL,                           'operating_expense', 'Other operating costs',               390, NULL),
  ('X1', 'payroll_expense',              'operating_expense', 'Payroll and staff costs',             310, 'Includes partner payments and rent recorded as payroll through direct credits (classification review)'),
  ('X1', 'salary_payout',                'operating_expense', 'Payroll and staff costs',             310, NULL),
  ('X1', 'interest_expense',             'operating_expense', 'Staff loyalty bonus (payroll growth balances)', 315, 'Posted under a finance-cost category; it is a staff cost'),
  ('X1', 'marketing_expense',            'operating_expense', 'Marketing and agent incentives',      320, 'Includes the 1% landlord-payout agent commission'),
  ('X1', 'research_development_expense', 'operating_expense', 'Research and development',            330, NULL),
  ('X1', 'general_admin_expense',        'operating_expense', 'General and administrative',          340, 'Includes wallet / merchant top-ups and share payments made through direct credits (classification review)'),
  ('X1', 'equipment_expense',            'operating_expense', 'Equipment (expensed)',                350, 'No fixed-asset accounts yet'),
  ('X1', 'tax_expense',                  'tax',               'Tax',                                 600, NULL),
  ('X5', NULL,                           'operating_expense', 'Reimbursement of agent-fronted payouts', 360, NULL),
  ('X4', NULL,                           'other', 'Credit losses and write-offs',                    410, NULL),
  ('X4', 'custody_recognised_on_bucket_reclass', 'other', 'Float moved to agents'' withdrawable (system-generated)', 420, 'Generated by the resolver; treatment pending CFO decision on float'),
  ('X4', 'float_derecognised_on_bucket_reclass', 'other', 'Float moved to agents'' withdrawable (system-generated)', 420, 'Generated by the resolver; treatment pending CFO decision on float'),
  ('X6', NULL,                           'other', 'Float corrections',                               430, 'Corrections of earlier float balances; may belong to prior periods')
ON CONFLICT (account_code, category) DO NOTHING;

-- Seed: Cash Flow lines by counterpart account (category overrides where one account mixes activities)
INSERT INTO public.fin_cash_flow_map (account_code, category, section, group_label, group_sort, line_in, line_out, sort) VALUES
  ('A3',  NULL, 'operating', 'Rent Plans', 10, 'Tenant repayments received', 'Rent paid for tenants', 10),
  ('A6',  NULL, 'operating', 'Landlord products', 20, 'Landlord receivables collected', 'Landlord receivables advanced', 10),
  ('L4',  NULL, 'operating', 'Landlord products', 20, 'Landlord obligations received', 'Landlord obligations settled', 20),
  ('A2',  NULL, 'operating', 'Agent float (company-owned)', 30, 'Float returned by agents', 'Float issued to agents', 10),
  ('A8',  NULL, 'operating', 'Agent float (company-owned)', 30, 'Float cycle settled', 'Float cycle issued', 20),
  ('A4',  NULL, 'operating', 'Agent advances and credit', 40, 'Other agent receivables collected', 'Other agent receivables advanced', 40),
  ('A10', NULL, 'operating', 'Agent advances and credit', 40, 'Agent advances recovered', 'Agent advances paid', 10),
  ('A11', NULL, 'operating', 'Agent advances and credit', 40, 'Advance fees collected', 'Advance fees advanced', 20),
  ('A20', NULL, 'operating', 'Agent advances and credit', 40, 'Advance registration fees collected', 'Advance registration fees advanced', 30),
  ('A12', NULL, 'operating', 'Merchandise and credit products', 50, 'Merchandise receivables collected', 'Merchandise receivables advanced', 10),
  ('A13', NULL, 'operating', 'Merchandise and credit products', 50, 'Bike receivables collected', 'Bike receivables advanced', 20),
  ('A14', NULL, 'operating', 'Merchandise and credit products', 50, 'Credit access collected', 'Credit access advanced', 30),
  ('A15', NULL, 'operating', 'Merchandise and credit products', 50, 'Merchandise credit collected', 'Merchandise credit advanced', 40),
  ('A24', NULL, 'operating', 'Merchandise and credit products', 50, 'Special advances collected', 'Special advances paid', 50),
  ('L1',  NULL, 'operating', 'Customer wallet funds (held for users)', 60, 'Customer funds received into wallets', 'Customer funds paid out of wallets', 10),
  ('L7',  NULL, 'operating', 'Fees and revenue', 70, 'Deferred fees received', 'Deferred fees released', 20),
  ('L5',  NULL, 'operating', 'Operating costs', 80, 'Agent commissions accrued', 'Agent commissions settled', 35),
  ('R1',  NULL, 'operating', 'Fees and revenue', 70, 'Fees and revenue received', 'Revenue refunded', 10),
  ('R2',  NULL, 'operating', 'Fees and revenue', 70, 'Advance fees received', 'Advance fees refunded', 15),
  ('X1',  NULL, 'operating', 'Operating costs', 80, 'Operating cost refunds', 'Operating costs paid', 10),
  ('X2',  NULL, 'operating', 'Operating costs', 80, 'Supporter Returns recovered', 'Supporter Returns paid', 20),
  ('X3',  NULL, 'operating', 'Operating costs', 80, 'Agent commissions recovered', 'Agent commissions paid', 30),
  ('X5',  NULL, 'operating', 'Operating costs', 80, 'Reimbursements recovered', 'Reimbursements of agent-fronted payouts', 40),
  ('X4',  NULL, 'operating', 'Corrections and adjustments', 90, 'Write-off recoveries', 'Write-offs settled in cash', 10),
  ('X6',  NULL, 'operating', 'Corrections and adjustments', 90, 'Float corrections (cash in)', 'Float corrections (cash out)', 20),
  ('E3',  NULL, 'operating', 'Corrections and adjustments', 90, 'Legacy adjustments (cash in)', 'Legacy adjustments (cash out)', 30),
  ('A9',  NULL, 'operating', 'Corrections and adjustments', 90, 'Suspense (unmapped) in', 'Suspense (unmapped) out', 40),
  ('L9',  NULL, 'operating', 'Corrections and adjustments', 90, 'Suspense (unmapped) in', 'Suspense (unmapped) out', 40),
  ('L2',  NULL, 'financing', 'Supporter capital', 10, 'Supporter capital received', 'Supporter capital repaid', 10),
  ('L6',  NULL, 'financing', 'Supporter capital', 10, 'Supporter top-ups received', 'Supporter top-ups applied', 20),
  ('A7',  NULL, 'financing', 'Supporter capital', 10, 'Promissory notes collected', 'Promissory notes advanced', 30),
  ('E1',  NULL, 'financing', 'Share capital', 20, 'Share capital received', 'Share capital returned', 10),
  ('A23', NULL, 'financing', 'Share capital', 20, 'Share capital receivables settled', 'Share capital receivables advanced', 20)
ON CONFLICT (account_code, category) DO NOTHING;

-- Seed: cash and cash equivalents (PROVISIONAL — CFO decisions D2 agent float not cash, D3 landlord pool restricted)
INSERT INTO public.fin_cash_accounts (code, label, restricted, included, note) VALUES
  ('A1',  'Cash and bank', false, true, 'Includes MoMo lines and bank until accounts are split'),
  ('A5',  'Cash collected, not yet confirmed banked', false, true, 'Verified and unverified custody cash'),
  ('A21', 'Landlord Float Pool — self-support (restricted)', true, true, 'Earmark of company cash for Rent Plans'),
  ('A22', 'Landlord Float Pool — company-managed (restricted)', true, true, 'Earmark of company cash for Rent Plans')
ON CONFLICT (code) DO NOTHING;

-- ── Income Statement ────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_income_statement(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the income statement';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'A valid period is required (from < to)';
  END IF;

  WITH l AS MATERIALIZED (
    SELECT s.account_code, s.category, s.dr, s.cr, s.transaction_date
    FROM public.sofp_ledger_legs(p_to - interval '1 microsecond') s
    WHERE s.account_code ~ '^(R|X)' AND s.transaction_date >= p_from AND s.transaction_date < p_to
  ), amt AS (
    SELECT account_code, category,
           SUM(CASE WHEN account_code LIKE 'R%' THEN cr - dr ELSE dr - cr END) AS amount,
           COUNT(*) AS legs
    FROM l GROUP BY 1, 2
  ), mapped AS (
    SELECT a.*,
           COALESCE(m1.section, m2.section, CASE WHEN a.account_code LIKE 'R%' THEN 'revenue' ELSE 'operating_expense' END) AS section,
           COALESCE(m1.line_label, m2.line_label, 'Other (' || a.account_code || ')') AS line,
           COALESCE(m1.sort, m2.sort, 900) AS sort,
           COALESCE(m1.flag, m2.flag) AS flag
    FROM amt a
    LEFT JOIN public.fin_pnl_lines m1 ON m1.account_code = a.account_code AND m1.category = a.category
    LEFT JOIN public.fin_pnl_lines m2 ON m2.account_code = a.account_code AND m2.category IS NULL
  ), lines AS (
    SELECT section, line, MIN(sort) AS sort, SUM(amount) AS amount, SUM(legs) AS legs, MAX(flag) AS flag,
           jsonb_agg(jsonb_build_object('account', account_code, 'category', category, 'amount', ROUND(amount), 'legs', legs)
                     ORDER BY abs(amount) DESC) AS detail
    FROM mapped GROUP BY 1, 2
  ), sec AS (
    SELECT section, SUM(amount) AS total,
           jsonb_agg(jsonb_build_object('label', line, 'amount', ROUND(amount), 'legs', legs, 'flag', flag, 'detail', detail)
                     ORDER BY sort, line) AS lines
    FROM lines GROUP BY 1
  ), tot AS (
    SELECT
      COALESCE((SELECT total FROM sec WHERE section = 'revenue'), 0)           AS revenue,
      COALESCE((SELECT total FROM sec WHERE section = 'cost_of_revenue'), 0)   AS cost_of_revenue,
      COALESCE((SELECT total FROM sec WHERE section = 'operating_expense'), 0) AS operating_expenses,
      COALESCE((SELECT total FROM sec WHERE section = 'other'), 0)             AS other_items,
      COALESCE((SELECT total FROM sec WHERE section = 'tax'), 0)               AS tax,
      COALESCE((SELECT SUM(cr - dr) FROM l WHERE account_code LIKE 'R%'), 0)   AS ledger_revenue,
      COALESCE((SELECT SUM(dr - cr) FROM l WHERE account_code LIKE 'X%'), 0)   AS ledger_expenses
  ), months AS (
    SELECT to_char(transaction_date AT TIME ZONE 'Africa/Kampala', 'YYYY-MM') AS month,
           SUM(CASE WHEN account_code LIKE 'R%' THEN cr - dr ELSE 0 END) AS revenue,
           SUM(CASE WHEN account_code LIKE 'X%' THEN dr - cr ELSE 0 END) AS expenses
    FROM l GROUP BY 1
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'currency', 'UGX', 'generated_at', now(),
    'basis', 'Revenue (R) and expense (X) accounts of the General Ledger, resolved by sofp_ledger_legs (the same resolution as the Balance Sheet). Lines group categories; the account decides the section. No operational tables, no category lists in the browser.',
    'sections', jsonb_build_object(
      'revenue',           COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'lines', lines) FROM sec WHERE section = 'revenue'),           jsonb_build_object('total', 0, 'lines', '[]'::jsonb)),
      'cost_of_revenue',   COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'lines', lines) FROM sec WHERE section = 'cost_of_revenue'),   jsonb_build_object('total', 0, 'lines', '[]'::jsonb)),
      'operating_expense', COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'lines', lines) FROM sec WHERE section = 'operating_expense'), jsonb_build_object('total', 0, 'lines', '[]'::jsonb)),
      'other',             COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'lines', lines) FROM sec WHERE section = 'other'),             jsonb_build_object('total', 0, 'lines', '[]'::jsonb)),
      'tax',               COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'lines', lines) FROM sec WHERE section = 'tax'),               jsonb_build_object('total', 0, 'lines', '[]'::jsonb))
    ),
    'totals', (SELECT jsonb_build_object(
        'revenue', ROUND(revenue),
        'cost_of_revenue', ROUND(cost_of_revenue),
        'gross_profit', ROUND(revenue - cost_of_revenue),
        'operating_expenses', ROUND(operating_expenses),
        'operating_result', ROUND(revenue - cost_of_revenue - operating_expenses),
        'other_items', ROUND(other_items),
        'result_before_tax', ROUND(revenue - cost_of_revenue - operating_expenses - other_items),
        'tax', ROUND(tax),
        'net_result', ROUND(revenue - cost_of_revenue - operating_expenses - other_items - tax)
      ) FROM tot),
    'reconciliation', (SELECT jsonb_build_object(
        'ledger_revenue', ROUND(ledger_revenue),
        'ledger_expenses', ROUND(ledger_expenses),
        'ledger_net', ROUND(ledger_revenue - ledger_expenses),
        'statement_net', ROUND(revenue - cost_of_revenue - operating_expenses - other_items - tax),
        'difference', ROUND((ledger_revenue - ledger_expenses) - (revenue - cost_of_revenue - operating_expenses - other_items - tax)),
        'ties_to_ledger', abs((ledger_revenue - ledger_expenses) - (revenue - cost_of_revenue - operating_expenses - other_items - tax)) < 1
      ) FROM tot),
    'months', COALESCE((SELECT jsonb_agg(jsonb_build_object('month', month, 'revenue', ROUND(revenue), 'expenses', ROUND(expenses),
                                                            'net_result', ROUND(revenue - expenses)) ORDER BY month) FROM months), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

-- ── Balance Sheet (current resolver statement + sub-ledger ties) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_balance_sheet(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $function$
DECLARE
  v_sofp jsonb;
  v_val  jsonb;
  v_ties jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the balance sheet';
  END IF;

  v_sofp := public.get_statement_of_financial_position(COALESCE(p_as_at, now()));

  -- account values by code, from the statement just produced
  SELECT jsonb_object_agg(substring(e->>'source' from 'account ([A-Z0-9]+)$'), (e->>'value')::numeric)
    INTO v_val
  FROM (
    SELECT jsonb_array_elements(COALESCE(v_sofp->'assets'->'current','[]'::jsonb) || COALESCE(v_sofp->'assets'->'non_current','[]'::jsonb)
                              || COALESCE(v_sofp->'liabilities'->'current','[]'::jsonb) || COALESCE(v_sofp->'liabilities'->'non_current','[]'::jsonb)) e
  ) z
  WHERE substring(e->>'source' from 'account ([A-Z0-9]+)$') IS NOT NULL;

  WITH w AS (
    SELECT COALESCE(SUM(withdrawable_balance),0) wd, COALESCE(SUM(locked_balance),0) lk,
           COALESCE(SUM(float_balance),0) fl, COALESCE(SUM(advance_balance),0) adv FROM public.wallets
  ), t AS (
    SELECT
      (SELECT COALESCE(SUM(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0)),0) FROM public.rent_requests
        WHERE status IN ('funded','disbursed','repaying') AND created_at <= COALESCE(p_as_at, now())) AS rent_book,
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0) + COALESCE(arrears_balance,0)),0) FROM public.agent_advances
        WHERE status IN ('active','overdue') AND created_at <= COALESCE(p_as_at, now())) AS advances,
      (SELECT COALESCE(SUM(investment_amount),0) FROM public.investor_portfolios
        WHERE status = 'active' AND created_at <= COALESCE(p_as_at, now())) AS portfolios,
      (SELECT COALESCE(SUM(amount - COALESCE(total_collected,0)),0) FROM public.promissory_notes
        WHERE status = 'activated' AND created_at <= COALESCE(p_as_at, now())) AS notes
  )
  SELECT jsonb_build_array(
    jsonb_build_object('key','rent_plans','label','Rent Plan receivables (A3) vs Rent Plan book',
      'ledger', ROUND(COALESCE((v_val->>'A3')::numeric,0)), 'operational', ROUND(t.rent_book),
      'difference', ROUND(COALESCE((v_val->>'A3')::numeric,0) - t.rent_book)),
    jsonb_build_object('key','agent_advances','label','Agent advances (A10+A11+A20) vs agent_advances outstanding + arrears',
      'ledger', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0)),
      'operational', ROUND(t.advances),
      'difference', ROUND(COALESCE((v_val->>'A10')::numeric,0) + COALESCE((v_val->>'A11')::numeric,0) + COALESCE((v_val->>'A20')::numeric,0) - t.advances)),
    jsonb_build_object('key','supporter_capital','label','Supporter capital (L2 less unpaid promissory notes A7) vs active portfolios',
      'ledger', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.portfolios),
      'difference', ROUND(COALESCE((v_val->>'L2')::numeric,0) - COALESCE((v_val->>'A7')::numeric,0) - t.portfolios)),
    jsonb_build_object('key','promissory_notes','label','Promissory notes (A7) vs activated notes uncollected',
      'ledger', ROUND(COALESCE((v_val->>'A7')::numeric,0)), 'operational', ROUND(t.notes),
      'difference', ROUND(COALESCE((v_val->>'A7')::numeric,0) - t.notes)),
    jsonb_build_object('key','wallet_custody','label','Wallet custody (L1) vs wallets withdrawable + locked',
      'ledger', ROUND(COALESCE((v_val->>'L1')::numeric,0)), 'operational', ROUND(w.wd + w.lk),
      'difference', ROUND(COALESCE((v_val->>'L1')::numeric,0) - (w.wd + w.lk))),
    jsonb_build_object('key','agent_float','label','Agent float (A2) vs wallets float',
      'ledger', ROUND(COALESCE((v_val->>'A2')::numeric,0)), 'operational', ROUND(w.fl),
      'difference', ROUND(COALESCE((v_val->>'A2')::numeric,0) - w.fl))
  ) INTO v_ties
  FROM w, t;

  RETURN v_sofp || jsonb_build_object(
    'engine', 'fin_balance_sheet',
    'subledger_ties', v_ties,
    'subledger_ties_basis', 'Ledger balances are as at the statement date; operational figures (wallets, Rent Plan balances, advances, portfolios, notes) are as they stand now, so ties for past dates are indicative only.',
    'disclosures', jsonb_build_array(
      'Partner Product Receivables (A7) are activated promissory notes not yet paid; the same amount is included in Supporter capital (L2).',
      'Landlord Float Pool (A21/A22) is company cash earmarked to fund Rent Plans (Supporter capital and compounded Returns), not money owed to landlords.',
      'Cash and Bank (A1) is negative mainly because verified cash deposits remain in Cash in Transit (A5); the two should be read together.',
      'Landlord Rent Payable (L4) holds no landlord obligations; its balance comes from resolver counterpart legs.')
  );
END;
$function$;

-- ── Cash Flow (direct method, no balancing line) ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_cash_flow(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view the statement of cash flows';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'A valid period is required (from < to)';
  END IF;

  WITH ca AS (
    SELECT code, label, restricted FROM public.fin_cash_accounts WHERE included
  ), l AS MATERIALIZED (
    SELECT s.transaction_group_id AS gid, s.account_code, s.category, s.dr, s.cr, s.transaction_date, s.is_legacy_counterpart
    FROM public.sofp_ledger_legs(p_to - interval '1 microsecond') s
  ), cash AS (
    SELECT l.* FROM l JOIN ca ON ca.code = l.account_code
  ), bal AS (
    SELECT COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date < p_from), 0) AS opening,
           COALESCE(SUM(dr - cr), 0) AS closing,
           COALESCE(SUM(dr - cr) FILTER (WHERE transaction_date >= p_from), 0) AS period_net
    FROM cash
  ), by_acct AS (
    SELECT ca.code, ca.label, ca.restricted,
           COALESCE(SUM(c.dr - c.cr) FILTER (WHERE c.transaction_date < p_from), 0) AS opening,
           COALESCE(SUM(c.dr - c.cr), 0) AS closing
    FROM ca LEFT JOIN cash c ON c.account_code = ca.code
    GROUP BY 1, 2, 3
  ), grp_cash AS (
    -- cash effect of each group inside the period
    SELECT gid, SUM(dr - cr) AS cash_effect
    FROM cash WHERE transaction_date >= p_from AND gid IS NOT NULL
    GROUP BY 1
  ), cp AS (
    -- counterpart legs of those groups (any non-cash account); internal cash<->cash moves have none
    -- only legs dated inside the period: a group whose legs carry different dates (e.g. a later reversal)
    -- contributes to each period by its own dates
    SELECT l.gid, l.account_code, l.category, (l.cr - l.dr) AS eff
    FROM l JOIN grp_cash g ON g.gid = l.gid
    WHERE l.account_code NOT IN (SELECT code FROM ca) AND l.transaction_date >= p_from
  ), mapped AS (
    SELECT cp.eff,
           COALESCE(m1.section, m2.section, m3.section, 'operating') AS section,
           COALESCE(m1.group_label, m2.group_label, m3.group_label, 'Unclassified') AS group_label,
           COALESCE(m1.group_sort, m2.group_sort, m3.group_sort, 99) AS group_sort,
           CASE WHEN cp.eff >= 0 THEN COALESCE(m1.line_in, m2.line_in, m3.line_in, 'Unclassified inflows (' || cp.account_code || ')')
                ELSE COALESCE(m1.line_out, m2.line_out, m3.line_out, 'Unclassified outflows (' || cp.account_code || ')') END AS line,
           COALESCE(m1.sort, m2.sort, m3.sort, 900) + CASE WHEN cp.eff >= 0 THEN 0 ELSE 1 END AS sort
    FROM cp
    LEFT JOIN public.fin_cash_flow_map m1 ON m1.account_code = cp.account_code AND m1.category = cp.category
    LEFT JOIN public.fin_cash_flow_map m2 ON m2.account_code = cp.account_code AND m2.category IS NULL
    LEFT JOIN public.fin_cash_flow_map m3 ON m3.account_code IS NULL AND m3.category = cp.category
  ), lines AS (
    SELECT section, group_label, MIN(group_sort) AS group_sort, line, MIN(sort) AS sort, SUM(eff) AS amount
    FROM mapped GROUP BY section, group_label, line
  ), grouped AS (
    SELECT section, group_label, MIN(group_sort) AS group_sort, SUM(amount) AS total,
           jsonb_agg(jsonb_build_object('label', line, 'amount', ROUND(amount)) ORDER BY sort, line) AS lines
    FROM lines GROUP BY section, group_label
  ), sections AS (
    SELECT section, SUM(total) AS total,
           jsonb_agg(jsonb_build_object('label', group_label, 'total', ROUND(total), 'lines', lines) ORDER BY group_sort, group_label) AS groups
    FROM grouped GROUP BY section
  ), explained AS (
    SELECT COALESCE(SUM(amount), 0) AS total FROM lines
  ), unexplained AS (
    -- groups whose counterparts do not account for their cash effect (one-sided or unbalanced after mapping)
    SELECT g.gid, g.cash_effect, COALESCE(SUM(cp.eff), 0) AS counterpart, g.cash_effect - COALESCE(SUM(cp.eff), 0) AS gap
    FROM grp_cash g LEFT JOIN cp ON cp.gid = g.gid
    GROUP BY g.gid, g.cash_effect
    HAVING abs(g.cash_effect - COALESCE(SUM(cp.eff), 0)) > 0.5
  ), ungrouped AS (
    -- cash legs without a group id (cannot be explained by counterparts)
    SELECT COALESCE(SUM(dr - cr), 0) AS amount FROM cash WHERE transaction_date >= p_from AND gid IS NULL
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'currency', 'UGX', 'engine', 'fin_cash_flow',
    'cash_definition', 'Cash and cash equivalents = ' || (SELECT string_agg(code || ' ' || label, '; ' ORDER BY code) FROM ca)
      || '. Agent float (A2) is a company asset with agents, shown as an operating movement, not as cash (provisional, CFO decision D2). '
      || 'Internal moves between these accounts are eliminated. No balancing line: any unexplained difference is reported below with its ledger groups.',
    'operating', COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'groups', groups) FROM sections WHERE section = 'operating'), jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
    'investing', COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'groups', groups) FROM sections WHERE section = 'investing'), jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
    'financing', COALESCE((SELECT jsonb_build_object('total', ROUND(total), 'groups', groups) FROM sections WHERE section = 'financing'), jsonb_build_object('total', 0, 'groups', '[]'::jsonb)),
    'exchange_rate_effect', 0,
    'net_change', ROUND((SELECT period_net FROM bal)),
    'explained_net_change', ROUND((SELECT total FROM explained)),
    'opening_cash', ROUND((SELECT opening FROM bal)),
    'closing_cash', ROUND((SELECT closing FROM bal)),
    'cash_accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', code, 'label', label, 'restricted', restricted,
                                  'opening', ROUND(opening), 'closing', ROUND(closing)) ORDER BY code) FROM by_acct), '[]'::jsonb),
    'balance_sheet_cash', ROUND(COALESCE((SELECT SUM(closing) FROM by_acct), 0)),
    'ties_to_balance_sheet', abs((SELECT closing FROM bal) - COALESCE((SELECT SUM(closing) FROM by_acct), 0)) < 1,
    'unreconciled_residual', ROUND((SELECT period_net FROM bal) - (SELECT total FROM explained)),
    'unexplained_difference', ROUND((SELECT period_net FROM bal) - (SELECT total FROM explained)),
    'unexplained_groups_count', (SELECT COUNT(*) FROM unexplained),
    'unexplained_ungrouped_amount', ROUND((SELECT amount FROM ungrouped)),
    'unexplained_groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('group', gid, 'cash_effect', ROUND(cash_effect), 'counterparts', ROUND(counterpart), 'gap', ROUND(gap)) ORDER BY abs(gap) DESC)
                                     FROM (SELECT * FROM unexplained ORDER BY abs(gap) DESC LIMIT 25) u), '[]'::jsonb),
    'reconciles', abs((SELECT opening FROM bal) + (SELECT total FROM explained) - (SELECT closing FROM bal)) < 1
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

-- ── Accounting health controls (read-only) ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_controls(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $function$
DECLARE
  v_at   timestamptz := COALESCE(p_as_at, now());
  v_bs   jsonb;
  v_cf   jsonb;
  v_out  jsonb := '[]'::jsonb;
  v_n    bigint; v_amt numeric; v_detail jsonb;
  v_month_start timestamptz := date_trunc('month', v_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala';
BEGIN
  IF NOT public._fin_can_view() THEN
    RAISE EXCEPTION 'Not authorised to view accounting controls';
  END IF;

  -- C01 Balance Sheet equality
  v_bs := public.fin_balance_sheet(v_at);
  v_amt := COALESCE((v_bs->'balance_check'->>'difference')::numeric, 0);
  v_out := v_out || jsonb_build_object('id','C01','name','Assets = Liabilities + Equity',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'fail' END, 'value', ROUND(v_amt),
    'detail', 'Difference on the Balance Sheet. Unbalanced groups are listed in control C02.');

  -- C02 Groups unbalanced after mapping, logged by the posting control in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(abs(residual)),0),
         COALESCE(jsonb_agg(jsonb_build_object('group', transaction_group_id, 'residual', ROUND(residual), 'source', source_table, 'at', detected_at) ORDER BY detected_at DESC) FILTER (WHERE rn <= 10), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM (SELECT v.*, row_number() OVER (ORDER BY detected_at DESC) rn FROM public.ledger_mapped_balance_violations v
        WHERE detected_at > v_at - interval '30 days') z;
  v_out := v_out || jsonb_build_object('id','C02','name','Entries unbalanced after account mapping (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C03 Suspense balances (A9 debit suspense and L9 credit suspense)
  v_amt := COALESCE((SELECT SUM(abs((e->>'value')::numeric)) FROM jsonb_array_elements(
             COALESCE(v_bs->'assets'->'current','[]'::jsonb) || COALESCE(v_bs->'liabilities'->'current','[]'::jsonb)) e
           WHERE e->>'source' LIKE '%account A9' OR e->>'source' LIKE '%account L9'), 0);
  v_out := v_out || jsonb_build_object('id','C03','name','Suspense (unmapped postings) balance',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'warn' END, 'value', ROUND(v_amt));

  -- C05 Cash Flow explained in full (current month)
  v_cf := public.fin_cash_flow(v_month_start, v_at);
  v_amt := COALESCE((v_cf->>'unexplained_difference')::numeric, 0);
  v_out := v_out || jsonb_build_object('id','C05','name','Cash Flow fully explained this month (no balancing line)',
    'status', CASE WHEN abs(v_amt) < 1 THEN 'ok' ELSE 'fail' END, 'value', ROUND(v_amt),
    'detail', v_cf->'unexplained_groups');

  -- C06 Mobile-money balances reported by provider SMS (freshness)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('channel', channel, 'balance', balance, 'at', at,
                     'hours_old', ROUND(EXTRACT(EPOCH FROM (v_at - at)) / 3600, 1))), '[]'::jsonb),
         COUNT(*) FILTER (WHERE at < v_at - interval '24 hours')
    INTO v_detail, v_n
  FROM (SELECT DISTINCT ON (channel) channel, balance, COALESCE(internal_date, created_at) at
        FROM public.gmail_transactions
        WHERE channel IN ('mtn_momo','airtel_money') AND balance IS NOT NULL AND from_email ILIKE '%ifttt%'
        ORDER BY channel, COALESCE(internal_date, created_at) DESC) z;
  v_out := v_out || jsonb_build_object('id','C06','name','Mobile-money line balances (provider SMS)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'detail', v_detail);

  -- C08 Deposits marked "banked" without a matching Equity credit email (same amount, ±3 days)
  WITH latest AS (
    SELECT DISTINCT ON (v.deposit_request_id) v.deposit_request_id, v.amount, v.status, COALESCE(v.verified_at, v.created_at) at
    FROM public.cash_deposit_verifications v ORDER BY v.deposit_request_id, v.created_at DESC
  ), banked AS (
    SELECT l.* FROM latest l JOIN public.deposit_requests dr ON dr.id = l.deposit_request_id
    WHERE l.status = 'verified' AND COALESCE(dr.purpose_audit->>'cash_location','cash_at_hand') = 'bank'
  ), unmatched AS (
    SELECT b.* FROM banked b
    WHERE NOT EXISTS (SELECT 1 FROM public.gmail_transactions g
                      WHERE g.from_email ILIKE '%equitybank%' AND g.direction = 'in' AND g.amount = b.amount
                        AND COALESCE(g.internal_date, g.created_at) BETWEEN b.at - interval '3 days' AND b.at + interval '3 days')
  )
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt FROM unmatched;
  v_out := v_out || jsonb_build_object('id','C08','name','Deposits marked banked with no matching Equity credit',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt),
    'detail', 'Bulk banking (several deposits in one credit) also appears here; review against bank statements.');

  -- C09 / C10 / C11 sub-ledger ties from the Balance Sheet
  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO v_detail FROM jsonb_array_elements(v_bs->'subledger_ties') e;
  v_out := v_out || jsonb_build_object('id','C09','name','Ledger vs operational records (wallets, portfolios, Rent Plans, advances, notes)',
    'status', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_bs->'subledger_ties') e WHERE abs((e->>'difference')::numeric) >= 1)
                   THEN 'warn' ELSE 'ok' END,
    'value', (SELECT COUNT(*) FROM jsonb_array_elements(v_bs->'subledger_ties') e WHERE abs((e->>'difference')::numeric) >= 1),
    'detail', v_detail);

  -- C11 Rent Plans marked completed while still owing, measured by collections actually received
  --     (a stored balance can be typed to zero, so it cannot be the test; review 9 Nov 2026)
  WITH col AS (
    SELECT rent_request_id rr, SUM(amount) collected
    FROM public.agent_collections WHERE reversed_at IS NULL AND rent_request_id IS NOT NULL GROUP BY 1
  )
  SELECT COUNT(*), COALESCE(SUM(COALESCE(r.total_repayment,0) - COALESCE(col.collected,0)),0) INTO v_n, v_amt
  FROM public.rent_requests r LEFT JOIN col ON col.rr = r.id
  WHERE r.status = 'completed' AND COALESCE(r.total_repayment,0) - COALESCE(col.collected,0) > 0.5;
  v_out := v_out || jsonb_build_object('id','C11','name','Rent Plans completed while still owing (by collections actually received)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt),
    'detail', 'Includes plans registered with older balances and plans cleared by staff edits; review against the Tenant Repayment Tracker.');

  -- C14 Back-dated postings (transaction date more than 2 days before posting) in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt
  FROM public.general_ledger
  WHERE created_at > v_at - interval '30 days' AND transaction_date < created_at - interval '2 days'
    AND classification IN ('production','legacy_real','admin_correction');
  v_out := v_out || jsonb_build_object('id','C14','name','Back-dated postings (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C15 Completed withdrawals with no ledger entry
  SELECT COUNT(*), COALESCE(SUM(w.amount),0) INTO v_n, v_amt
  FROM public.withdrawal_requests w
  WHERE w.status IN ('completed','paid')
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id);
  v_out := v_out || jsonb_build_object('id','C15','name','Paid withdrawals with no ledger entry',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C16 Abnormal merchandise recovery plans
  SELECT COUNT(*), COALESCE(SUM(outstanding_balance),0),
         COALESCE(jsonb_agg(jsonb_build_object('plan', id, 'item', item_name, 'outstanding', ROUND(outstanding_balance), 'daily', ROUND(daily_deduction_amount), 'status', status)), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM public.merchandise_recovery_plans
  WHERE status = 'active' AND (COALESCE(original_amount,0) > 50000000 OR COALESCE(daily_deduction_amount,0) > 2000000);
  v_out := v_out || jsonb_build_object('id','C16','name','Abnormal merchandise recovery plans (> 50M or > 2M a day)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C19 Landlord payouts still open on Rent Plans whose funding was reversed (allocation returned)
  WITH rev AS (
    SELECT g.source_id rr FROM public.general_ledger g
    WHERE g.source_table = 'rent_requests' AND g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
    GROUP BY 1 HAVING SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END) <= 0.5
                  AND bool_or(g.direction = 'cash_in')
  )
  SELECT COUNT(*), COALESCE(SUM(p.amount),0),
         COALESCE(jsonb_agg(jsonb_build_object('payout', p.id, 'rent_request', p.rent_request_id, 'amount', p.amount, 'status', p.status, 'created', p.created_at)), '[]'::jsonb)
    INTO v_n, v_amt, v_detail
  FROM public.landlord_payouts p JOIN rev ON rev.rr = p.rent_request_id
  WHERE p.status IN ('pending','otp_verified','pending_merchant_payout');
  v_out := v_out || jsonb_build_object('id','C19','name','Landlord payouts still open after the allocation was returned',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'fail' END, 'value', v_n, 'amount', ROUND(v_amt), 'detail', v_detail);

  -- C20 Rent Plans funded in the ledger with no successful landlord payout after 7 days
  WITH led AS (
    SELECT g.source_id rr, SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END) net, MIN(g.transaction_date) first_d
    FROM public.general_ledger g
    WHERE g.source_table = 'rent_requests' AND g.category = 'rent_disbursement' AND g.ledger_scope = 'platform'
      AND g.classification IN ('production','legacy_real')
    GROUP BY 1
  )
  SELECT COUNT(*), COALESCE(SUM(led.net),0) INTO v_n, v_amt
  FROM led
  WHERE led.net > 0.5 AND led.first_d < v_at - interval '7 days' AND led.first_d >= timestamptz '2026-06-01 00:00+03'
    AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts p WHERE p.rent_request_id = led.rr
                    AND p.status IN ('completed','awaiting_agent_receipt','pending_merchant_payout'));
  v_out := v_out || jsonb_build_object('id','C20','name','Rent Plans funded in the ledger with no landlord payout (since June, older than 7 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  -- C21 Admin-correction wallet legs (move wallets, excluded from statements) in the last 30 days
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_n, v_amt
  FROM public.general_ledger gl
  WHERE gl.ledger_scope = 'wallet' AND gl.classification = 'admin_correction' AND gl.created_at > v_at - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM public.general_ledger g2 WHERE g2.transaction_group_id = gl.transaction_group_id
                    AND g2.classification IN ('production','legacy_real'));
  v_out := v_out || jsonb_build_object('id','C21','name','Wallet corrections left out of the statements (last 30 days)',
    'status', CASE WHEN v_n = 0 THEN 'ok' ELSE 'warn' END, 'value', v_n, 'amount', ROUND(v_amt));

  RETURN jsonb_build_object('as_at', v_at, 'generated_at', now(), 'controls', v_out,
    'summary', jsonb_build_object(
      'fail', (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'fail'),
      'warn', (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'warn'),
      'ok',   (SELECT COUNT(*) FROM jsonb_array_elements(v_out) e WHERE e->>'status' = 'ok')));
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_income_statement(timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_balance_sheet(timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_cash_flow(timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_controls(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_income_statement(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_balance_sheet(timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_cash_flow(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_controls(timestamptz) TO authenticated, service_role;
