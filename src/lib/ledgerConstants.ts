export const LEDGER_SCOPE = {
  PLATFORM: 'platform',
  WALLET: 'wallet',
  BRIDGE: 'bridge',
} as const;

export const FINAL_WITHDRAWAL_STATUSES = ['approved', 'fin_ops_approved'];

// Agent wallet segmentation categories
export const AGENT_FLOAT_CATEGORIES = {
  DEPOSIT: 'agent_float_deposit',
  USED_FOR_RENT: 'agent_float_used_for_rent',
} as const;

export const AGENT_COMMISSION_CATEGORIES = {
  EARNED: 'agent_commission_earned',
  WITHDRAWAL: 'agent_commission_withdrawal',
  USED_FOR_RENT: 'agent_commission_used_for_rent',
  PARTNER_COMMISSION: 'partner_commission',
} as const;

/**
 * LOCKED CATEGORIES — the ONLY categories allowed in production.
 * Matches the allowlist in create_ledger_transaction() and validate_ledger_category().
 * When strict_mode is enabled in treasury_controls, any category NOT in this list
 * will be hard-rejected by the database.
 */
export const LOCKED_CATEGORIES = [
  // Revenue (platform earns)
  'access_fee_collected',
  'registration_fee_collected',
  // Cash in (real money entering)
  'wallet_deposit',
  'tenant_repayment',
  'tenant_repayment_collected',
  'agent_repayment',
  'partner_funding',
  'share_capital',
  // Rent engine
  'rent_disbursement',
  'rent_receivable_created',
  'rent_principal_collected',
  // ROI system
  'roi_expense',
  'roi_wallet_credit',
  'roi_reinvestment',
  // Commissions
  'agent_commission_earned',
  'agent_commission_withdrawal',
  'agent_commission_used_for_rent',
  // Wallet operations
  'wallet_withdrawal',
  'wallet_transfer',
  'wallet_deduction',
  // System
  'system_balance_correction',
  'orphan_reassignment',
  'orphan_reversal',
  // Agent float
  'agent_float_deposit',
  'agent_float_used_for_rent',
  'agent_float_assignment',
  'agent_float_settlement',
  // Agent advances
  'agent_advance_credit',
  // Portfolio
  'pending_portfolio_topup',
  // GAAP expense categories
  'marketing_expense',
  'payroll_expense',
  'general_admin_expense',
  'research_development_expense',
  'tax_expense',
  'interest_expense',
  'equipment_expense',
  // Partner commission
  'partner_commission',
  // Debt recovery
  'debt_recovery',
] as const;

export type LockedCategory = typeof LOCKED_CATEGORIES[number];

/**
 * Canonical REVENUE categories shown on CFO Revenue/Expense dashboards & reports.
 * Every category here is ALWAYS rendered (even if 0 activity in the period)
 * so the CFO never silently loses visibility on a revenue stream.
 */
export const CFO_REVENUE_CATEGORIES: { category: string; label: string }[] = [
  { category: 'access_fee_collected', label: 'Access Fees' },
  { category: 'registration_fee_collected', label: 'Registration Fees' },
  { category: 'tenant_access_fee', label: 'Tenant Access Fee (legacy)' },
  { category: 'tenant_request_fee', label: 'Tenant Request Fee (legacy)' },
  { category: 'platform_service_income', label: 'Platform Service Income' },
  { category: 'partner_commission', label: 'Partner Commission Revenue' },
  { category: 'debt_recovery', label: 'Debt Recovery (recovered cash)' },
  { category: 'tenant_default_charge', label: 'Tenant Default Penalty (33%)' },
  { category: 'share_capital', label: 'Share Capital Inflow' },
];

/**
 * Canonical EXPENSE categories shown on CFO Revenue/Expense dashboards & reports.
 * Includes every GAAP expense bucket so Marketing, R&D, Payroll, Welile Dowry etc.
 * are always visible — even when zero in the period.
 */
export const CFO_EXPENSE_CATEGORIES: { category: string; label: string }[] = [
  { category: 'marketing_expense', label: 'Marketing & Customer Acquisition' },
  { category: 'payroll_expense', label: 'Payroll & Salaries' },
  { category: 'general_admin_expense', label: 'General & Admin (incl. Welile Dowry)' },
  { category: 'research_development_expense', label: 'Research & Development' },
  { category: 'tax_expense', label: 'Taxes' },
  { category: 'interest_expense', label: 'Interest Expense' },
  { category: 'equipment_expense', label: 'Equipment & Capex' },
  { category: 'roi_expense', label: 'Supporter ROI Payouts' },
  { category: 'agent_commission_earned', label: 'Agent Commissions (earned)' },
  { category: 'agent_commission_withdrawal', label: 'Agent Commission Withdrawals' },
  { category: 'rent_disbursement', label: 'Rent Facilitation Disbursements' },
  { category: 'wallet_withdrawal', label: 'Wallet Withdrawals' },
  { category: 'supporter_platform_rewards', label: 'Supporter Rewards (legacy)' },
  { category: 'agent_commission_payout', label: 'Agent Commission Payout (legacy)' },
  { category: 'transaction_platform_expenses', label: 'Transaction & Platform Expenses (legacy)' },
  { category: 'operational_expenses', label: 'Operational Expenses (legacy)' },
];

/**
 * Plain-English description shown at the top of each per-category report.
 * Helps the CFO understand what a zero-activity category MEANS, not just that it's empty.
 */
export const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  // Revenue
  access_fee_collected: 'One-time access fees collected when tenants unlock rent facilitation.',
  registration_fee_collected: 'Registration fees collected from new tenants on first signup.',
  tenant_access_fee: 'Legacy tenant access fee category — superseded by access_fee_collected.',
  tenant_request_fee: 'Legacy per-request tenant fee category.',
  platform_service_income: 'Miscellaneous service income (SMS, premium features, advisory).',
  partner_commission: 'Proxy-agent commissions earned on partner deposits (2% instant).',
  debt_recovery: 'Cash recovered from defaulted accounts via wallet deductions.',
  tenant_default_charge: '33% penalty applied to tenants whose rent term expired with an outstanding balance.',
  share_capital: 'Equity injections — share capital paid in by founders/investors.',

  // Expense
  marketing_expense: 'Customer acquisition costs: ads, campaigns, brand activations, agent referral promos.',
  payroll_expense: 'Staff salaries, contractor payouts, benefits, statutory contributions.',
  general_admin_expense: 'Office rent, utilities, legal, insurance, Welile Dowry awards, and other G&A.',
  research_development_expense: 'Product engineering, AI experiments, infrastructure R&D, prototyping.',
  tax_expense: 'Corporate tax, VAT remittances, withholding tax, regulatory fees.',
  interest_expense: 'Cost of borrowed capital — interest paid on credit lines or partner loans.',
  equipment_expense: 'Hardware, devices, vehicles, agent kits, capex acquisitions.',
  roi_expense: 'Returns paid to Supporters (Funders) on their facilitation capital.',
  agent_commission_earned: 'Commissions credited to agents for verified rent collections (platform expense).',
  agent_commission_withdrawal: 'Cash paid out to agents withdrawing their earned commissions.',
  rent_disbursement: 'Rent facilitation payouts sent to landlords on behalf of tenants.',
  wallet_withdrawal: 'User-initiated wallet withdrawals (cash leaving the platform).',
  supporter_platform_rewards: 'Legacy supporter reward category.',
  agent_commission_payout: 'Legacy agent commission payout category.',
  transaction_platform_expenses: 'Legacy transaction/platform fee expenses.',
  operational_expenses: 'Legacy catch-all operating expenses.',
};

