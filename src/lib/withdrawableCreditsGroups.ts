/** Friendly source groups for withdrawable-credit ledger categories. Shared by the CFO card and the credits report. */
const GROUPS: Record<string, string> = {
  roi_wallet_credit: 'Supporter returns',
  roi_payout: 'Supporter returns',
  wallet_deposit: 'Deposits',
  wallet_transfer: 'Wallet transfers in',
  bucket_reclass_in: 'Float moved to withdrawable',
  agent_commission: 'Commissions',
  agent_commission_earned: 'Commissions',
  partner_commission: 'Commissions',
  proxy_investment_commission: 'Commissions',
  agent_investment_commission: 'Commissions',
  agent_advance_credit: 'Agent advances',
  system_balance_correction: 'Corrections',
};

/** Mirrors `_cfo_credit_type` in the database — keep the two in sync. */
export function creditsGroupLabel(category: string): string {
  return (
    GROUPS[category] ??
    (category.includes('bonus') ? 'Bonuses'
      : category.includes('salary') || category.includes('payroll') ? 'Salary & payroll'
      : category.includes('correction') ? 'Corrections'
      : category.includes('commission') ? 'Commissions'
      : 'Other')
  );
}

/** All possible source groups, in display order (matches the report's Type filter). */
export const CREDITS_GROUP_LABELS = [
  'Supporter returns',
  'Deposits',
  'Wallet transfers in',
  'Float moved to withdrawable',
  'Commissions',
  'Agent advances',
  'Corrections',
  'Bonuses',
  'Salary & payroll',
  'Other',
];
