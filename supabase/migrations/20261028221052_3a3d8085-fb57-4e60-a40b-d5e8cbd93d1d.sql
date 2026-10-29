CREATE OR REPLACE FUNCTION public._cfo_paid_category_for(p_category text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_category
    WHEN 'general_admin_expense' THEN 'budget'
    WHEN 'payroll_expense' THEN 'budget'
    WHEN 'salary_payout' THEN 'budget'
    WHEN 'operational_expenses' THEN 'budget'
    WHEN 'platform_expense' THEN 'budget'
    WHEN 'platform_expense_disbursement' THEN 'budget'
    WHEN 'transaction_platform_expenses' THEN 'budget'
    WHEN 'tax_expense' THEN 'budget'
    WHEN 'interest_expense' THEN 'budget'
    WHEN 'equipment_expense' THEN 'budget'
    WHEN 'platform_loss_writeoff' THEN 'budget'
    WHEN 'merchant_oop_reimbursement' THEN 'budget'
    WHEN 'agent_requisition' THEN 'budget'
    WHEN 'rent_disbursement' THEN 'landlord'
    WHEN 'landlord_pool_deploy_company_managed' THEN 'landlord'
    WHEN 'landlord_pool_release_company_managed' THEN 'landlord'
    WHEN 'landlord_pool_release_self_support' THEN 'landlord'
    WHEN 'agent_commission_earned' THEN 'agent'
    WHEN 'agent_commission_payable' THEN 'agent'
    WHEN 'agent_commission_payout' THEN 'agent'
    WHEN 'agent_commission' THEN 'agent'
    WHEN 'agent_bonus' THEN 'agent'
    WHEN 'referral_bonus' THEN 'agent'
    WHEN 'roi_expense' THEN 'partner'
    WHEN 'roi_payout' THEN 'partner'
    WHEN 'supporter_platform_rewards' THEN 'partner'
    WHEN 'partner_commission' THEN 'partner'
    WHEN 'agent_landlord_payout' THEN 'landlord'
    WHEN 'landlord_receivable_obligation' THEN 'landlord'
    WHEN 'marketing_expense' THEN 'marketing'
    WHEN 'research_development_expense' THEN 'rnd'
    ELSE NULL
  END;
$function$;