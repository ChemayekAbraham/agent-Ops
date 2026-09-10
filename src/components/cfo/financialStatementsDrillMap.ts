// Maps user-visible LineItem labels in FinancialStatementsPanel to the
// underlying general_ledger query (categories + optional scope + direction).
// Keep keys EXACTLY as rendered.

export type Scope = 'platform' | 'wallet' | 'bridge';
export type Direction = 'cash_in' | 'cash_out';

export interface DrillSpec {
  categories: string[];
  scope?: Scope;
  direction?: Direction;
}

export const FS_DRILL_MAP: Record<string, DrillSpec> = {
  // ── Income Statement: Realized Revenue (platform inflow)
  'Tenant Access Fees':              { categories: ['tenant_access_fee', 'access_fee', 'access_fee_collected'], scope: 'platform', direction: 'cash_in' },
  'Tenant Request Fees':             { categories: ['tenant_request_fee', 'request_fee', 'registration_fee_collected'], scope: 'platform', direction: 'cash_in' },
  'Other Service Income':            { categories: ['platform_service_income', 'landlord_platform_fee', 'management_fee'], scope: 'platform', direction: 'cash_in' },

  // ── Income Statement: Cost of Revenue (platform outflow)
  'Platform Rewards (Supporters)':   { categories: ['supporter_platform_rewards', 'supporter_reward', 'investment_reward', 'roi_payout', 'roi_expense'], scope: 'platform', direction: 'cash_out' },
  'Agent Commissions':               { categories: ['agent_commission_payout', 'agent_commission_earned'], scope: 'platform', direction: 'cash_out' },
  'Transaction Expenses':            { categories: ['transaction_platform_expenses', 'agent_commission_earned'], scope: 'platform', direction: 'cash_out' },

  // ── Income Statement: Operating Expenses (platform outflow)
  'Payroll & Staff Costs':           { categories: ['salary_payment', 'employee_advance', 'payroll_expense'], scope: 'platform', direction: 'cash_out' },
  'Marketing Expenses':              { categories: ['marketing_expense'], scope: 'platform', direction: 'cash_out' },
  'Research & Development':          { categories: ['research_development_expense'], scope: 'platform', direction: 'cash_out' },
  'Tax Expense':                     { categories: ['tax_expense'], scope: 'platform', direction: 'cash_out' },
  'Interest Expense':                { categories: ['interest_expense'], scope: 'platform', direction: 'cash_out' },
  'Equipment & Depreciation':        { categories: ['equipment_expense'], scope: 'platform', direction: 'cash_out' },
  'General & Admin Expenses':        { categories: ['general_admin_expense', 'operational_expenses'], scope: 'platform', direction: 'cash_out' },

  // ── Cash Flow: Platform Operating Activities
  'Tenant Fees Received':            { categories: ['tenant_access_fee', 'access_fee', 'access_fee_collected', 'tenant_request_fee', 'request_fee', 'registration_fee_collected'], scope: 'platform', direction: 'cash_in' },
  'Other Platform Income':           { categories: ['platform_service_income', 'landlord_platform_fee', 'management_fee'], scope: 'platform', direction: 'cash_in' },
  'Platform Rewards Paid':           { categories: ['supporter_platform_rewards', 'supporter_reward', 'investment_reward', 'roi_payout', 'roi_expense'], scope: 'platform', direction: 'cash_out' },
  'Agent Commissions Paid':          { categories: ['agent_commission_payout', 'agent_commission_earned'], scope: 'platform', direction: 'cash_out' },
  'Agent Commission Withdrawals':    { categories: ['agent_commission_withdrawal'], scope: 'wallet', direction: 'cash_out' },
  'Agent Commission Used for Rent':  { categories: ['agent_commission_used_for_rent'], scope: 'wallet', direction: 'cash_out' },
  'Payroll Paid':                    { categories: ['salary_payment', 'payroll_expense'], scope: 'platform', direction: 'cash_out' },
  'Marketing Expenses Paid':         { categories: ['marketing_expense'], scope: 'platform', direction: 'cash_out' },
  'R&D Expenses Paid':               { categories: ['research_development_expense'], scope: 'platform', direction: 'cash_out' },

  // ── Cash Flow: Rent Facilitation
  // `tenant_repayment_collected` (agent field collections, CR A3) posts cash_out
  // while the legacy categories post cash_in, so no single direction pin fits.
  // The drill dialog already sums cash_in and cash_out separately.
  'Rent Repayments Received':        { categories: ['rent_repayment', 'loan_repayment', 'tenant_repayment', 'tenant_repayment_collected'], scope: 'platform' },
  'Rent Principal Collected':        { categories: ['rent_principal_collected'], direction: 'cash_in' },
  'Agent Repayments':                { categories: ['agent_repayment'], scope: 'platform', direction: 'cash_in' },
  'Rent Deployed to Landlords':      { categories: ['rent_disbursement'], direction: 'cash_out' },
  'Rent Disbursements':              { categories: ['rent_disbursement'], scope: 'platform', direction: 'cash_out' },
};
