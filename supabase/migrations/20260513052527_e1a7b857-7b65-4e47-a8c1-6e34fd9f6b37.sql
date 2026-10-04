CREATE OR REPLACE FUNCTION public.assert_routing_compatible(p_category text, p_recipient_type text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Money OWNED by an individual — must never land in an operational/float wallet.
  IF p_recipient_type = 'operational_wallet' AND p_category IN (
    'payroll_expense','salary_payout',
    'roi_wallet_credit','roi_payout',
    'agent_commission_earned','agent_commission','agent_bonus',
    'partner_commission','referral_bonus',
    'proxy_investment_commission','agent_investment_commission',
    'system_balance_correction','wallet_transfer','manager_credit',
    'marketing_expense','general_admin_expense','research_development_expense',
    'tax_expense','interest_expense','equipment_expense',
    -- Advance recovery is debt repayment from a user's withdrawable bucket.
    -- It must NEVER come out of float (company custody money).
    'agent_repayment','agent_advance_repayment','salary_advance_repayment','debt_recovery'
  ) THEN
    RAISE EXCEPTION 'INVALID_ROUTING: category % cannot target an operational wallet (must go to a user)', p_category
      USING ERRCODE = 'check_violation';
  END IF;

  -- Operational/company funds — must never land in a user's withdrawable bucket.
  IF p_recipient_type = 'user' AND p_category IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','rent_float_funding','rent_disbursement'
  ) THEN
    RAISE EXCEPTION 'INVALID_ROUTING: category % cannot target a user wallet (must go to an operational wallet)', p_category
      USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;