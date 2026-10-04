CREATE OR REPLACE FUNCTION public.get_statement_of_financial_position(p_as_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cash_bank numeric := 0;
  v_cash_hand numeric := 0;
  v_rent_access numeric := 0;
  v_business_adv numeric := 0;
  v_credit_draws numeric := 0;
  v_agent_adv numeric := 0;
  v_agent_adv_fees numeric := 0;
  v_agent_bike numeric := 0;
  v_agent_phone numeric := 0;
  v_agent_rent numeric := 0;
  v_agent_other numeric := 0;
  v_service_centres numeric := 0;
  v_promissory numeric := 0;
  v_partner_compounding numeric := 0;
  v_partner_topups numeric := 0;
  v_homes_fee numeric := 0;
  v_homes_outstanding numeric := 0;
  v_dowry numeric := 0;
  v_school numeric := 0;
  v_cars numeric := 0;
  v_other_recv numeric := 0;
  v_ppe numeric := 0;
  v_rou numeric := 0;
  v_intangibles numeric := 0;
  v_share_recv numeric := 0;
  v_other_assets numeric := 0;
  v_user_custody numeric := 0;
  v_partner_portfolios numeric := 0;
  v_partner_roi_payable numeric := 0;
  v_landlord_payable numeric := 0;
  v_other_payables numeric := 0;
  v_advance_liability numeric := 0;
  v_share_capital numeric := 0;
  v_other_contrib numeric := 0;
  v_revenue numeric := 0;
  v_expenses numeric := 0;
  v_retained numeric := 0;
  v_tca numeric; v_tnca numeric; v_ta numeric;
  v_tcl numeric; v_tncl numeric; v_tl numeric;
  v_te numeric; v_diff numeric;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the statement of financial position';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE -amount END), 0)
    INTO v_cash_bank
  FROM general_ledger
  WHERE ledger_scope = 'platform'
    AND classification IN ('production','legacy_real')
    AND category <> 'opening_balance'
    AND transaction_date <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(float_balance,0)),0) INTO v_cash_hand FROM wallets;

  SELECT COALESCE(SUM(GREATEST(COALESCE(total_repayment,0) - COALESCE(amount_repaid,0),0)),0)
    INTO v_rent_access
  FROM rent_requests
  WHERE status IN ('funded','disbursed','repaying') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(outstanding_balance,0)),0) INTO v_business_adv
  FROM business_advances WHERE status IN ('active','defaulted') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(outstanding_balance,0)),0) INTO v_credit_draws
  FROM credit_access_draws WHERE status IN ('active','overdue') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(outstanding_balance,0) + GREATEST(arrears_balance,0)),0) INTO v_agent_adv
  FROM agent_advances WHERE status IN ('active','overdue') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(access_fee,0) - COALESCE(access_fee_collected,0),0)),0) INTO v_agent_adv_fees
  FROM agent_advances WHERE status IN ('active','overdue') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(amount_outstanding,0),0)),0) INTO v_agent_bike
  FROM merchandise_sales WHERE item_name ILIKE '%bike%' AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(amount_outstanding,0),0)),0) INTO v_agent_phone
  FROM merchandise_sales WHERE (item_name ILIKE '%smartphone%' OR item_name ILIKE '%phone%') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(agent_liability_amount,0),0)),0) INTO v_agent_rent
  FROM rent_requests WHERE agent_liability_triggered IS TRUE AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(amount_outstanding,0),0)),0) INTO v_agent_other
  FROM merchandise_sales
  WHERE item_name NOT ILIKE '%bike%' AND item_name NOT ILIKE '%smartphone%' AND item_name NOT ILIKE '%phone%'
    AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(outstanding_balance,0)),0) INTO v_service_centres
  FROM merchandise_recovery_plans WHERE status = 'active' AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(amount,0) - COALESCE(total_collected,0),0)),0) INTO v_promissory
  FROM promissory_notes WHERE status IN ('pending','activated') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(total_roi_earned,0),0)),0) INTO v_partner_compounding
  FROM investor_portfolios
  WHERE status = 'active' AND (auto_reinvest IS TRUE OR roi_mode = 'compound') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(amount,0)),0) INTO v_partner_topups
  FROM funder_pending_portfolios WHERE status = 'pending' AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(landlord_fee,0),0)),0) INTO v_homes_fee
  FROM welile_homes_monthly_dues WHERE collection_status <> 'collected' AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(COALESCE(outstanding_balance,0),0)),0) INTO v_homes_outstanding
  FROM welile_homes_subscriptions WHERE subscription_status = 'active' AND created_at <= p_as_at;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE -amount END),0) INTO v_dowry
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND transaction_date <= p_as_at AND (category ILIKE '%dowry%' OR description ILIKE '%welile dowry%');

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE -amount END),0) INTO v_school
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND transaction_date <= p_as_at AND (category ILIKE '%school_of_ai%' OR description ILIKE '%school of ai%');

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE -amount END),0) INTO v_cars
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND transaction_date <= p_as_at AND (category ILIKE '%welile_cars%' OR description ILIKE '%welile cars%');

  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0) INTO v_other_recv
  FROM general_ledger
  WHERE ledger_scope='bridge' AND classification IN ('production','legacy_real')
    AND category = 'rent_receivable_created' AND transaction_date <= p_as_at;
  v_other_recv := GREATEST(v_other_recv - v_rent_access, 0);

  SELECT COALESCE(SUM(CASE WHEN direction='cash_out' THEN amount ELSE -amount END),0) INTO v_ppe
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND category = 'equipment_expense' AND transaction_date <= p_as_at;

  SELECT COALESCE(SUM(CASE WHEN direction='cash_out' THEN amount ELSE -amount END),0) INTO v_rou
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND transaction_date <= p_as_at AND (category ILIKE '%right_of_use%' OR category ILIKE '%lease%');

  SELECT COALESCE(SUM(CASE WHEN direction='cash_out' THEN amount ELSE -amount END),0) INTO v_intangibles
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND transaction_date <= p_as_at AND (category ILIKE '%intangible%' OR category ILIKE '%software%');

  SELECT COALESCE(SUM(GREATEST(amount,0)),0) INTO v_share_recv
  FROM angel_pool_investments WHERE status NOT IN ('confirmed','deleted') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(withdrawable_balance,0) + GREATEST(locked_balance,0)),0) INTO v_user_custody FROM wallets;

  SELECT COALESCE(SUM(GREATEST(investment_amount,0)),0) INTO v_partner_portfolios
  FROM investor_portfolios WHERE status = 'active' AND created_at <= p_as_at;

  v_partner_roi_payable := v_partner_compounding;

  SELECT COALESCE(SUM(GREATEST(amount,0)),0) INTO v_landlord_payable
  FROM landlord_payouts
  WHERE status IN ('pending_merchant_payout','awaiting_agent_receipt') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(amount,0)),0) INTO v_other_payables
  FROM withdrawal_requests
  WHERE status IN ('pending','processing','approved','re_approved_for_recovery') AND created_at <= p_as_at;

  SELECT COALESCE(SUM(GREATEST(advance_balance,0)),0) INTO v_advance_liability FROM wallets;

  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0) INTO v_share_capital
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND category IN ('share_capital','pool_capital_received') AND transaction_date <= p_as_at;

  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0) INTO v_other_contrib
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND transaction_date <= p_as_at
    AND (category ILIKE '%shareholder%' OR category ILIKE '%founder%' OR category ILIKE '%owner_contribution%');

  SELECT COALESCE(SUM(amount),0) INTO v_revenue
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND direction = 'cash_in' AND transaction_date <= p_as_at
    AND category IN ('access_fee_collected','registration_fee_collected','tenant_access_fee','tenant_request_fee',
                     'access_fee','request_fee','platform_service_income','landlord_platform_fee','management_fee',
                     'partner_commission','debt_recovery','tenant_default_charge');

  SELECT COALESCE(SUM(amount),0) INTO v_expenses
  FROM general_ledger
  WHERE ledger_scope='platform' AND classification IN ('production','legacy_real')
    AND direction = 'cash_out' AND transaction_date <= p_as_at
    AND category IN ('marketing_expense','payroll_expense','general_admin_expense','research_development_expense',
                     'tax_expense','interest_expense','equipment_expense','roi_expense','roi_payout',
                     'agent_commission_earned','agent_commission_payout','agent_commission_payable',
                     'platform_loss_writeoff','transaction_platform_expenses','operational_expenses',
                     'supporter_platform_rewards');

  v_retained := v_revenue - v_expenses;

  v_tca := v_cash_bank + v_cash_hand + v_rent_access + v_business_adv + v_credit_draws
         + v_agent_adv + v_agent_adv_fees + v_agent_bike + v_agent_phone + v_agent_rent + v_agent_other
         + v_service_centres + v_promissory + v_partner_compounding + v_partner_topups
         + v_homes_fee + v_homes_outstanding + v_dowry + v_school + v_cars + v_other_recv;
  v_tnca := v_ppe + v_rou + v_intangibles + v_share_recv + v_other_assets;
  v_ta := v_tca + v_tnca;

  v_tcl := v_user_custody + v_partner_roi_payable + v_landlord_payable + v_other_payables + v_advance_liability;
  v_tncl := v_partner_portfolios;
  v_tl := v_tcl + v_tncl;

  v_te := v_share_capital + v_other_contrib + v_retained + v_share_recv;
  v_diff := v_ta - (v_tl + v_te);

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'generated_at', now(),
    'currency', 'UGX',
    'assets', jsonb_build_object(
      'current', jsonb_build_array(
        jsonb_build_object('label','Cash at Bank / Platform Treasury','value',v_cash_bank,'source','general_ledger (platform scope, net as at date)'),
        jsonb_build_object('label','Cash at Hand (float with agents)','value',v_cash_hand,'source','wallets.float_balance'),
        jsonb_build_object('label','Rent Access Receivables (Tenants)','value',v_rent_access,'source','rent_requests (funded/disbursed/repaying)'),
        jsonb_build_object('label','Tenant Business Advances','value',v_business_adv,'source','business_advances'),
        jsonb_build_object('label','Tenant Credit Access Draws','value',v_credit_draws,'source','credit_access_draws'),
        jsonb_build_object('label','Agent Advances','value',v_agent_adv,'source','agent_advances outstanding + arrears'),
        jsonb_build_object('label','Agent Advance Access Fees Receivable','value',v_agent_adv_fees,'source','agent_advances access fee uncollected'),
        jsonb_build_object('label','Agent Bike Receivables','value',v_agent_bike,'source','merchandise_sales (bike)'),
        jsonb_build_object('label','Agent Smartphone Receivables','value',v_agent_phone,'source','merchandise_sales (smartphone)'),
        jsonb_build_object('label','Agent Individual Rent Receivables','value',v_agent_rent,'source','rent_requests agent liability'),
        jsonb_build_object('label','Other Agent Receivables','value',v_agent_other,'source','merchandise_sales (other items)'),
        jsonb_build_object('label','Receivables from Service Centers','value',v_service_centres,'source','merchandise_recovery_plans (active)'),
        jsonb_build_object('label','Partners'' Promissory Notes','value',v_promissory,'source','promissory_notes'),
        jsonb_build_object('label','Partners'' Compounding ROI','value',v_partner_compounding,'source','investor_portfolios (compounding, ROI accrued)'),
        jsonb_build_object('label','Partners'' Top-Ups (awaiting application)','value',v_partner_topups,'source','funder_pending_portfolios'),
        jsonb_build_object('label','Landlord Welile Homes Fees (10%)','value',v_homes_fee,'source','welile_homes_monthly_dues.landlord_fee'),
        jsonb_build_object('label','Welile Homes Subscription Receivables','value',v_homes_outstanding,'source','welile_homes_subscriptions'),
        jsonb_build_object('label','Welile Dowry','value',v_dowry,'source','general_ledger (dowry-tagged)'),
        jsonb_build_object('label','Welile School of AI','value',v_school,'source','general_ledger (school of AI-tagged)'),
        jsonb_build_object('label','Welile Cars','value',v_cars,'source','general_ledger (cars-tagged)'),
        jsonb_build_object('label','Other Receivables','value',v_other_recv,'source','bridge rent_receivable_created not in rent plans')
      ),
      'non_current', jsonb_build_array(
        jsonb_build_object('label','Property and Equipment','value',v_ppe,'source','general_ledger equipment_expense'),
        jsonb_build_object('label','Rights-of-Use Assets','value',v_rou,'source','general_ledger lease/right-of-use'),
        jsonb_build_object('label','Software and Other Intangible Assets','value',v_intangibles,'source','general_ledger intangible/software'),
        jsonb_build_object('label','Share Receivables','value',v_share_recv,'source','angel_pool_investments not yet confirmed'),
        jsonb_build_object('label','Other Assets','value',v_other_assets,'source','no accounts posted')
      ),
      'total_current', v_tca,
      'total_non_current', v_tnca,
      'total', v_ta
    ),
    'liabilities', jsonb_build_object(
      'current', jsonb_build_array(
        jsonb_build_object('label','Welile Balances with Payables (user wallet custody)','value',v_user_custody,'source','wallets withdrawable + locked'),
        jsonb_build_object('label','Partners'' ROI / Rewards Payable','value',v_partner_roi_payable,'source','investor_portfolios ROI accrued unpaid'),
        jsonb_build_object('label','Landlord Rent Payable','value',v_landlord_payable,'source','landlord_payouts pending'),
        jsonb_build_object('label','Other Pending Payables (withdrawals in flight)','value',v_other_payables,'source','withdrawal_requests pending/processing/approved'),
        jsonb_build_object('label','Agent Advance Liability Held in Wallets','value',v_advance_liability,'source','wallets.advance_balance')
      ),
      'non_current', jsonb_build_array(
        jsonb_build_object('label','Partner Portfolios (capital held)','value',v_partner_portfolios,'source','investor_portfolios active')
      ),
      'total_current', v_tcl,
      'total_non_current', v_tncl,
      'total', v_tl
    ),
    'equity', jsonb_build_object(
      'lines', jsonb_build_array(
        jsonb_build_object('label','Shareholders'' Capital Contributions','value',v_share_capital,'source','general_ledger share_capital + pool_capital_received'),
        jsonb_build_object('label','Other Shareholders'' Contributions','value',v_other_contrib,'source','general_ledger shareholder/founder contributions'),
        jsonb_build_object('label','Share Capital Receivables','value',v_share_recv,'source','angel_pool_investments not yet confirmed'),
        jsonb_build_object('label','Retained Earnings / (Accumulated Deficit)','value',v_retained,'source','general_ledger cumulative revenue less expenses')
      ),
      'revenue_to_date', v_revenue,
      'expenses_to_date', v_expenses,
      'total', v_te
    ),
    'balance_check', jsonb_build_object(
      'total_assets', v_ta,
      'total_liabilities_and_equity', v_tl + v_te,
      'difference', v_diff,
      'balanced', abs(v_diff) < 1
    )
  );
END;
$$;