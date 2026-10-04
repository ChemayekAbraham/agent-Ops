-- 1. Chart of accounts used by the statement of financial position
CREATE TABLE IF NOT EXISTS public.ledger_account_catalog (
  code text PRIMARY KEY,
  label text NOT NULL,
  section text NOT NULL CHECK (section IN ('current_asset','non_current_asset','current_liability','non_current_liability','equity','revenue','expense')),
  nature text NOT NULL CHECK (nature IN ('asset','liability','equity','revenue','expense')),
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ledger_account_catalog TO authenticated;
GRANT ALL ON public.ledger_account_catalog TO service_role;
ALTER TABLE public.ledger_account_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Finance roles read the chart of accounts" ON public.ledger_account_catalog;
CREATE POLICY "Finance roles read the chart of accounts"
ON public.ledger_account_catalog FOR SELECT TO authenticated
USING (
  has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'coo')
  OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'financial_ops')
  OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'cto')
);

-- 2. Ledger category -> account map. debit_when says which cash direction is the DEBIT side
--    for that account, because platform-scope mirror legs are recorded inverted for some flows.
CREATE TABLE IF NOT EXISTS public.ledger_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_scope text NOT NULL,
  category text NOT NULL,
  wallet_bucket text,
  account_code text NOT NULL REFERENCES public.ledger_account_catalog(code),
  debit_when text NOT NULL DEFAULT 'cash_in' CHECK (debit_when IN ('cash_in','cash_out')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_account_map_key
  ON public.ledger_account_map (ledger_scope, category, COALESCE(wallet_bucket,'*'));

GRANT SELECT ON public.ledger_account_map TO authenticated;
GRANT ALL ON public.ledger_account_map TO service_role;
ALTER TABLE public.ledger_account_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Finance roles read the account map" ON public.ledger_account_map;
CREATE POLICY "Finance roles read the account map"
ON public.ledger_account_map FOR SELECT TO authenticated
USING (
  has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'coo')
  OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'financial_ops')
  OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'cto')
);
DROP TRIGGER IF EXISTS trg_ledger_account_map_touch ON public.ledger_account_map;
CREATE TRIGGER trg_ledger_account_map_touch
BEFORE UPDATE ON public.ledger_account_map
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.ledger_account_catalog (code,label,section,nature,sort_order) VALUES
 ('A1','Cash and Bank Balances','current_asset','asset',10),
 ('A2','Cash at Hand — Float with Agents','current_asset','asset',20),
 ('A3','Rent Access Receivables (Tenants)','current_asset','asset',30),
 ('A4','Advances and Other Receivables','current_asset','asset',40),
 ('A9','Suspense — Unresolved Postings (debit balance)','current_asset','asset',90),
 ('L1','Wallet Custody Payable (user balances)','current_liability','liability',10),
 ('L3','Partner Returns / Rewards Payable','current_liability','liability',20),
 ('L4','Landlord Rent Payable','current_liability','liability',30),
 ('L5','Agent Commission Payable','current_liability','liability',40),
 ('L6','Partner Top-Ups Awaiting Application','current_liability','liability',50),
 ('L9','Suspense — Unresolved Postings (credit balance)','current_liability','liability',90),
 ('L2','Partner Portfolios — Capital Held','non_current_liability','liability',10),
 ('E1','Shareholders'' Capital Contributions','equity','equity',10),
 ('E3','Legacy Opening Balance Adjustments','equity','equity',20),
 ('R1','Platform Revenue','revenue','revenue',10),
 ('X1','Operating Expenses','expense','expense',10),
 ('X2','Partner Returns (ROI) Expense','expense','expense',20),
 ('X3','Agent Commission Expense','expense','expense',30),
 ('X4','Credit Losses and Write-offs','expense','expense',40)
ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label, section=EXCLUDED.section, nature=EXCLUDED.nature, sort_order=EXCLUDED.sort_order;

INSERT INTO public.ledger_account_map (ledger_scope,category,wallet_bucket,account_code,debit_when) VALUES
 ('platform','access_fee_collected',NULL,'R1','cash_out'),
 ('platform','agent_bonus',NULL,'X1','cash_out'),
 ('platform','agent_commission_earned',NULL,'X3','cash_out'),
 ('platform','agent_commission_payable',NULL,'X3','cash_out'),
 ('platform','agent_commission_payout',NULL,'X3','cash_out'),
 ('platform','agent_float_deposit',NULL,'A1','cash_in'),
 ('platform','agent_float_funding',NULL,'A1','cash_in'),
 ('platform','agent_float_settlement',NULL,'A1','cash_in'),
 ('platform','agent_float_topup',NULL,'A1','cash_in'),
 ('platform','agent_float_used_for_rent',NULL,'A3','cash_in'),
 ('platform','agent_landlord_payout',NULL,'A1','cash_in'),
 ('platform','agent_repayment',NULL,'A4','cash_out'),
 ('platform','balance_correction',NULL,'E3','cash_out'),
 ('platform','equipment_expense',NULL,'X1','cash_out'),
 ('platform','general_admin_expense',NULL,'X1','cash_out'),
 ('platform','historical_balance_reseed',NULL,'E3','cash_out'),
 ('platform','interest_expense',NULL,'X1','cash_out'),
 ('platform','listing_rejection_recovery',NULL,'R1','cash_out'),
 ('platform','manager_credit',NULL,'X1','cash_out'),
 ('platform','marketing_expense',NULL,'X1','cash_out'),
 ('platform','partner_funding',NULL,'L2','cash_out'),
 ('platform','payroll_expense',NULL,'X1','cash_out'),
 ('platform','pending_portfolio_topup',NULL,'L6','cash_out'),
 ('platform','platform_expense',NULL,'X1','cash_out'),
 ('platform','platform_loss_writeoff',NULL,'X4','cash_out'),
 ('platform','pool_capital_received',NULL,'E1','cash_out'),
 ('platform','pool_rent_deployment',NULL,'A3','cash_out'),
 ('platform','registration_fee_collected',NULL,'R1','cash_out'),
 ('platform','rent_disbursement',NULL,'A1','cash_in'),
 ('platform','rent_repayment',NULL,'A3','cash_out'),
 ('platform','research_development_expense',NULL,'X1','cash_out'),
 ('platform','roi_expense',NULL,'X2','cash_out'),
 ('platform','roi_reinvestment',NULL,'L2','cash_out'),
 ('platform','roi_wallet_credit',NULL,'X2','cash_in'),
 ('platform','salary_payout',NULL,'X1','cash_out'),
 ('platform','share_capital',NULL,'E1','cash_out'),
 ('platform','supporter_platform_rewards',NULL,'X1','cash_out'),
 ('platform','tax_expense',NULL,'X1','cash_out'),
 ('platform','tenant_access_fee',NULL,'R1','cash_out'),
 ('platform','tenant_repayment',NULL,'A3','cash_out'),
 ('platform','wallet_deduction',NULL,'A4','cash_out'),
 ('platform','wallet_deduction_cash_payout_retraction',NULL,'A4','cash_out'),
 ('platform','wallet_deduction_general_adjustment',NULL,'A4','cash_out'),
 ('platform','wallet_deposit',NULL,'A1','cash_out'),
 ('platform','wallet_transfer',NULL,'A1','cash_out'),
 ('platform','wallet_withdrawal',NULL,'A1','cash_out'),
 ('bridge','agent_commission',NULL,'X3','cash_out'),
 ('bridge','partner_funding',NULL,'L2','cash_out'),
 ('bridge','rent_receivable_created',NULL,'A3','cash_in'),
 ('bridge','supporter_facilitation_capital',NULL,'L2','cash_out'),
 ('bridge','orphan_reassignment',NULL,'A9','cash_in'),
 ('bridge','orphan_reversal',NULL,'A9','cash_in'),
 ('wallet','agent_float_assignment',NULL,'A2','cash_in'),
 ('wallet','agent_float_deposit',NULL,'A2','cash_in'),
 ('wallet','agent_float_settlement',NULL,'A2','cash_in'),
 ('wallet','agent_float_topup',NULL,'A2','cash_in'),
 ('wallet','agent_float_used_for_rent',NULL,'A2','cash_in'),
 ('wallet','rent_float_funding',NULL,'A2','cash_in'),
 ('wallet','proxy_partner_withdrawal',NULL,'A2','cash_in'),
 ('wallet','advance_repayment',NULL,'A4','cash_in')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket,'*'))
DO UPDATE SET account_code = EXCLUDED.account_code, debit_when = EXCLUDED.debit_when;

-- 3. Ledger legs mapped to the chart of accounts (reporting helper, read-only)
CREATE OR REPLACE FUNCTION public.sofp_ledger_legs(p_as_at timestamptz)
RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, account_code text, dr numeric, cr numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT gl.transaction_group_id, gl.ledger_scope, gl.category, a.account_code,
         CASE WHEN gl.direction = a.debit_when THEN gl.amount ELSE 0 END,
         CASE WHEN gl.direction = a.debit_when THEN 0 ELSE gl.amount END
  FROM general_ledger gl
  CROSS JOIN LATERAL (
    SELECT COALESCE(m.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float' THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet' THEN 'L1'
                  ELSE 'A9' END) AS account_code,
           COALESCE(m.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet' THEN 'cash_out'
                  ELSE 'cash_in' END) AS debit_when
    FROM (SELECT 1) z
    LEFT JOIN LATERAL (
      SELECT mm.account_code, mm.debit_when
      FROM ledger_account_map mm
      WHERE mm.ledger_scope = gl.ledger_scope
        AND mm.category = gl.category
        AND (mm.wallet_bucket IS NULL OR mm.wallet_bucket = gl.wallet_bucket)
      ORDER BY (mm.wallet_bucket IS NOT NULL) DESC
      LIMIT 1
    ) m ON TRUE
  ) a
  WHERE gl.classification IN ('production','legacy_real')
    AND gl.transaction_date <= p_as_at;
$fn$;

REVOKE ALL ON FUNCTION public.sofp_ledger_legs(timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.sofp_ledger_legs(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sofp_ledger_legs(timestamptz) TO service_role;

-- 4. Statement of financial position, rebuilt as a ledger trial balance.
CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_dr numeric := 0;
  v_cr numeric := 0;
  v_sections jsonb := '{}'::jsonb;
  v_revenue numeric := 0;
  v_expenses numeric := 0;
  v_retained numeric := 0;
  v_tca numeric := 0; v_tnca numeric := 0; v_ta numeric := 0;
  v_tcl numeric := 0; v_tncl numeric := 0; v_tl numeric := 0;
  v_te numeric := 0; v_residual numeric := 0;
  v_assets_current jsonb; v_assets_non_current jsonb;
  v_liab_current jsonb; v_liab_non_current jsonb; v_equity jsonb;
  v_unresolved jsonb; v_unresolved_groups bigint := 0; v_unresolved_abs numeric := 0;
  v_excluded jsonb; v_memo jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the statement of financial position';
  END IF;

  WITH bal AS (
    SELECT l.account_code, SUM(l.dr) dr, SUM(l.cr) cr
    FROM sofp_ledger_legs(p_as_at) l GROUP BY 1
  ), signed AS (
    SELECT c.code, c.label, c.section, c.nature, c.sort_order,
           CASE WHEN c.nature IN ('asset','expense') THEN COALESCE(b.dr,0) - COALESCE(b.cr,0)
                ELSE COALESCE(b.cr,0) - COALESCE(b.dr,0) END AS value,
           COALESCE(b.dr,0) dr, COALESCE(b.cr,0) cr
    FROM ledger_account_catalog c
    LEFT JOIN bal b ON b.account_code = c.code
  )
  SELECT jsonb_object_agg(section, lines), SUM(dr_t), SUM(cr_t)
  INTO v_sections, v_dr, v_cr
  FROM (
    SELECT section,
           jsonb_agg(jsonb_build_object(
             'label', label, 'value', value,
             'source', 'general_ledger trial balance — account ' || code
           ) ORDER BY sort_order) lines,
           SUM(dr) dr_t, SUM(cr) cr_t
    FROM signed
    GROUP BY section
  ) s;

  v_assets_current     := COALESCE(v_sections->'current_asset','[]'::jsonb);
  v_assets_non_current := COALESCE(v_sections->'non_current_asset','[]'::jsonb);
  v_liab_current       := COALESCE(v_sections->'current_liability','[]'::jsonb);
  v_liab_non_current   := COALESCE(v_sections->'non_current_liability','[]'::jsonb);
  v_equity             := COALESCE(v_sections->'equity','[]'::jsonb);

  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_revenue
  FROM jsonb_array_elements(COALESCE(v_sections->'revenue','[]'::jsonb)) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_expenses
  FROM jsonb_array_elements(COALESCE(v_sections->'expense','[]'::jsonb)) e;
  v_retained := v_revenue - v_expenses;

  v_equity := v_equity || jsonb_build_array(jsonb_build_object(
    'label','Retained Earnings / (Accumulated Deficit)',
    'value', v_retained,
    'source','general_ledger trial balance — revenue accounts less expense accounts'
  ));

  WITH g AS (
    SELECT transaction_group_id, SUM(dr) - SUM(cr) resid FROM sofp_ledger_legs(p_as_at) GROUP BY 1
  ), u AS (
    SELECT * FROM g WHERE abs(resid) > 0.5
  )
  SELECT COUNT(*), COALESCE(SUM(abs(resid)),0) INTO v_unresolved_groups, v_unresolved_abs FROM u;

  WITH g AS (
    SELECT transaction_group_id, SUM(dr) - SUM(cr) resid FROM sofp_ledger_legs(p_as_at) GROUP BY 1
  ), u AS (
    SELECT * FROM g WHERE abs(resid) > 0.5
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'net_debit_less_credit')::numeric DESC), '[]'::jsonb)
  INTO v_unresolved
  FROM (
    SELECT jsonb_build_object(
             'ledger_scope', l.ledger_scope,
             'category', l.category,
             'groups', COUNT(DISTINCT l.transaction_group_id),
             'net_debit_less_credit', ROUND(SUM(l.dr - l.cr))
           ) x
    FROM sofp_ledger_legs(p_as_at) l
    JOIN u ON u.transaction_group_id = l.transaction_group_id
    GROUP BY l.ledger_scope, l.category
    HAVING abs(SUM(l.dr - l.cr)) > 0.5
    ORDER BY abs(SUM(l.dr - l.cr)) DESC
    LIMIT 25
  ) y;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'classification', classification, 'legs', legs, 'amount', amount) ORDER BY amount DESC), '[]'::jsonb)
  INTO v_excluded
  FROM (
    SELECT classification, COUNT(*) legs, ROUND(SUM(amount)) amount
    FROM general_ledger
    WHERE classification NOT IN ('production','legacy_real')
      AND transaction_date <= p_as_at
    GROUP BY classification
  ) e;

  SELECT jsonb_build_array(
    jsonb_build_object('label','Rent plans outstanding (rent_requests)','value',
      (SELECT COALESCE(SUM(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0)),0)
         FROM rent_requests WHERE status IN ('funded','disbursed','repaying') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Agent advances outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0) + COALESCE(arrears_balance,0)),0)
         FROM agent_advances WHERE status IN ('active','overdue') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Tenant business advances outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0)),0)
         FROM business_advances WHERE status IN ('active','defaulted') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Credit access draws outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(outstanding_balance,0)),0)
         FROM credit_access_draws WHERE status IN ('active','overdue') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Merchandise sales outstanding','value',
      (SELECT COALESCE(SUM(COALESCE(amount_outstanding,0)),0)
         FROM merchandise_sales WHERE created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Promissory notes uncollected','value',
      (SELECT COALESCE(SUM(COALESCE(amount,0) - COALESCE(total_collected,0)),0)
         FROM promissory_notes WHERE status IN ('pending','activated') AND created_at <= p_as_at),
      'source','operational sub-ledger — not recognised in the ledger totals'),
    jsonb_build_object('label','Partner portfolios per investor_portfolios (comparison)','value',
      (SELECT COALESCE(SUM(investment_amount),0) FROM investor_portfolios
        WHERE status = 'active' AND created_at <= p_as_at),
      'source','operational sub-ledger — compare against ledger account L2'),
    jsonb_build_object('label','Wallet cache: withdrawable + locked (comparison)','value',
      (SELECT COALESCE(SUM(withdrawable_balance + locked_balance),0) FROM wallets),
      'source','wallet cache — compare against ledger account L1'),
    jsonb_build_object('label','Wallet cache: float (comparison)','value',
      (SELECT COALESCE(SUM(float_balance),0) FROM wallets),
      'source','wallet cache — compare against ledger account A2'),
    jsonb_build_object('label','Landlord payouts pending (comparison)','value',
      (SELECT COALESCE(SUM(amount),0) FROM landlord_payouts
        WHERE status IN ('pending_merchant_payout','awaiting_agent_receipt') AND created_at <= p_as_at),
      'source','operational sub-ledger — compare against ledger account L4')
  ) INTO v_memo;

  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tca FROM jsonb_array_elements(v_assets_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tnca FROM jsonb_array_elements(v_assets_non_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tcl FROM jsonb_array_elements(v_liab_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_tncl FROM jsonb_array_elements(v_liab_non_current) e;
  SELECT COALESCE(SUM((e->>'value')::numeric),0) INTO v_te FROM jsonb_array_elements(v_equity) e;

  v_residual := (v_tca + v_tnca) - (v_tcl + v_tncl + v_te);

  IF v_residual > 0.5 THEN
    v_liab_current := v_liab_current || jsonb_build_array(jsonb_build_object(
      'label','Suspense — one-sided ledger postings awaiting their counterpart',
      'value', v_residual,
      'source','general_ledger groups whose debits and credits do not agree (see reconciliation schedule)'));
    v_tcl := v_tcl + v_residual;
  ELSIF v_residual < -0.5 THEN
    v_assets_current := v_assets_current || jsonb_build_array(jsonb_build_object(
      'label','Suspense — one-sided ledger postings awaiting their counterpart',
      'value', -v_residual,
      'source','general_ledger groups whose debits and credits do not agree (see reconciliation schedule)'));
    v_tca := v_tca - v_residual;
  END IF;

  v_ta := v_tca + v_tnca;
  v_tl := v_tcl + v_tncl;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'generated_at', now(),
    'currency', 'UGX',
    'assets', jsonb_build_object(
      'current', v_assets_current, 'non_current', v_assets_non_current,
      'total_current', v_tca, 'total_non_current', v_tnca, 'total', v_ta
    ),
    'liabilities', jsonb_build_object(
      'current', v_liab_current, 'non_current', v_liab_non_current,
      'total_current', v_tcl, 'total_non_current', v_tncl, 'total', v_tl
    ),
    'equity', jsonb_build_object(
      'lines', v_equity,
      'revenue_to_date', v_revenue,
      'expenses_to_date', v_expenses,
      'total', v_te
    ),
    'trial_balance', jsonb_build_object(
      'total_debits', ROUND(v_dr),
      'total_credits', ROUND(v_cr),
      'difference', ROUND(v_dr - v_cr),
      'balanced', abs(v_dr - v_cr) < 1
    ),
    'reconciliation', jsonb_build_object(
      'suspense_amount', ROUND(abs(v_residual)),
      'suspense_side', CASE WHEN v_residual > 0.5 THEN 'liability' WHEN v_residual < -0.5 THEN 'asset' ELSE 'none' END,
      'unresolved_groups', v_unresolved_groups,
      'unresolved_absolute_amount', ROUND(v_unresolved_abs),
      'schedule', v_unresolved,
      'excluded_classifications', v_excluded,
      'memo_sub_ledgers', v_memo
    ),
    'balance_check', jsonb_build_object(
      'total_assets', v_ta,
      'total_liabilities_and_equity', v_tl + v_te,
      'difference', v_ta - (v_tl + v_te),
      'balanced', abs(v_ta - (v_tl + v_te)) < 1
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_statement_of_financial_position(timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.get_statement_of_financial_position(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_statement_of_financial_position(timestamptz) TO service_role;