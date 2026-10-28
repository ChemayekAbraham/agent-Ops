// Wallet/platform ledger categories per scheduled payout category.
export const SCHEDULED_PAYOUT_CATEGORIES: Record<string, { walletCat: string; platformCat: string; impact: string }> = {
  roi_payout: { walletCat: 'roi_wallet_credit', platformCat: 'roi_expense', impact: 'expense' },
  agent_commission: { walletCat: 'agent_commission_earned', platformCat: 'agent_commission_earned', impact: 'expense' },
  payroll: { walletCat: 'salary_payout', platformCat: 'payroll_expense', impact: 'expense' },
  // Wallet leg uses `wallet_deposit` (user-visible), NOT
  // `system_balance_correction` — that category is excluded from the
  // nightly `reconcile_wallet_cache_to_ledger` reconciliation, which
  // wipes it back out of withdrawable_balance every night at 02:15
  // UTC. `system_balance_correction` is reserved for one-off admin
  // corrections/write-offs, not recurring operational payouts. The
  // platform leg keeps `system_balance_correction` — it's the
  // company's own ledger, not a user wallet, and isn't affected.
  marketing_expenses: { walletCat: 'wallet_deposit', platformCat: 'system_balance_correction', impact: 'expense' },
  research_development: { walletCat: 'wallet_deposit', platformCat: 'system_balance_correction', impact: 'expense' },
  operational_expense: { walletCat: 'wallet_deposit', platformCat: 'system_balance_correction', impact: 'expense' },
  // Staff lunch allowance is a payroll cost (Operational Expenses, X1),
  // matching manually posted lunch payments; the wallet leg is unchanged.
  lunch_allowance: { walletCat: 'wallet_deposit', platformCat: 'payroll_expense', impact: 'expense' },
  correction_credit: { walletCat: 'system_balance_correction', platformCat: 'system_balance_correction', impact: 'neutral' },
  wallet_transfer_out: { walletCat: 'wallet_transfer', platformCat: 'wallet_transfer', impact: 'neutral' },
};
