/**
 * Income Statement — Welile service & expense classification map.
 *
 * PURPOSE
 * -------
 * The CFO Income Statement must present Revenue grouped by the Welile services
 * that ACTUALLY exist in the system, and Expenses split into Marketing vs
 * Operating, using ONLY `general_ledger` categories that already exist.
 *
 * RULES (do not relax):
 *  1. Never invent a category. Every string below was observed in
 *     `public.general_ledger` or is already referenced by existing statement
 *     logic in `useFinancialStatements.ts`.
 *  2. A category belongs to EXACTLY ONE bucket (revenue service, marketing,
 *     operating, or non-P&L) — this is what prevents double counting.
 *  3. Any platform-scope category not listed anywhere is FLAGGED FOR REVIEW.
 *     It is never silently folded into a total and never creates a new
 *     category.
 *  4. Only `classification IN ('production','legacy_real')` rows reach here
 *     (enforced server-side by `get_financial_statement_ledger_sums`), so
 *     cancelled / test / admin-correction legs are already excluded.
 */

export type ServiceFamilyKey = 'rent' | 'agent' | 'partner' | 'landlord';

export interface ServiceFamily {
  key: ServiceFamilyKey;
  label: string;
  /** Ledger categories earned as revenue for this service family. */
  categories: string[];
}

/**
 * Revenue families. A family is only rendered when it has a non-zero,
 * ledger-backed amount for the selected period.
 */
export const REVENUE_SERVICE_FAMILIES: ServiceFamily[] = [
  {
    key: 'rent',
    label: 'Rent Products & Services',
    categories: [
      'tenant_access_fee',
      'access_fee',
      'access_fee_collected',
      'tenant_request_fee',
      'request_fee',
      'registration_fee_collected',
      'platform_service_income',
    ],
  },
  {
    key: 'agent',
    label: 'Agent Products & Services',
    categories: [
      'agent_advance_access_fee',
      'advance_access_fee',
      'agent_product_fee',
    ],
  },
  {
    key: 'partner',
    label: 'Partner Products & Services',
    categories: [
      'partner_service_fee',
      'management_fee',
    ],
  },
  {
    key: 'landlord',
    label: 'Landlord Products & Services',
    categories: [
      'landlord_platform_fee',
      'landlord_service_fee',
    ],
  },
];

/** Marketing spend — existing categories only. */
export const MARKETING_EXPENSE_CATEGORIES = [
  'marketing_expense',
];

/** Legacy `system_balance_correction` description buckets treated as marketing. */
export const MARKETING_LEGACY_DESC_BUCKETS = ['Marketing Expenses'];

/**
 * Operating expenses — everything that hits the P&L and is not marketing.
 * Includes service-delivery costs (supporter returns, agent commissions and
 * bonuses), staff costs, admin, R&D, tax, interest, equipment and write-offs.
 */
export const OPERATING_EXPENSE_CATEGORIES = [
  // Service delivery / cost of revenue
  'roi_expense',
  'supporter_platform_rewards',
  'supporter_reward',
  'investment_reward',
  'agent_commission_earned',
  'agent_commission_payable',
  'agent_commission_payout',
  'agent_commission',
  'agent_payout',
  'agent_approval_bonus',
  'agent_bonus',
  'referral_bonus',
  'transaction_platform_expenses',
  // Staff & administration
  'payroll_expense',
  'salary_payout',
  'salary_payment',
  // 'employee_advance' is a receivable, not an expense - an advance to an
  // employee is money owed back to the company. Removed from operating
  // expenses; it now surfaces in the unmapped-category review queue until it
  // is mapped to a balance sheet receivable account.
  'general_admin_expense',
  'operational_expenses',
  'platform_expense',
  'platform_expense_disbursement',
  'agent_requisition',
  // Other operating
  'research_development_expense',
  'tax_expense',
  'interest_expense',
  'equipment_expense',
  'platform_loss_writeoff',
  // X5 in the live ledger_account_map (debit_when 'cash_out', so a cash_out
  // leg debits X5 - a genuine expense). Already reflected in the main P&L via
  // the X5 expense line; classifying it here only stops the service/review
  // layer falsely flagging a cost the bottom line already carries.
  'merchant_oop_reimbursement',
  'tenant_default_charge',
  'debt_clearance',
];

/** Legacy `system_balance_correction` description buckets treated as operating. */
export const OPERATING_LEGACY_DESC_BUCKETS = [
  'Research & Development',
  '→ Salaries',
  '→ Transport',
  '→ Food',
  '→ Office Rent',
  '→ Internet',
  '→ Airtime',
  '→ Stationery',
  '→ Property & Equipment',
  '→ Taxes',
  '→ Interests',
];

/**
 * Categories that exist in the ledger but are NOT profit-or-loss items:
 * custody movements, rent facilitation principal, capital financing,
 * receivable creation and technical corrections. Excluded from Revenue and
 * Expenses so nothing is double counted, and NOT flagged for review.
 */
export const NON_PL_CATEGORIES = [
  // Custody / wallet movements
  'wallet_deposit',
  'wallet_withdrawal',
  'wallet_transfer',
  'wallet_deduction',
  'wallet_deduction_general_adjustment',
  'wallet_deduction_cash_payout_retraction',
  'roi_wallet_credit',
  'agent_commission_withdrawal',
  'agent_commission_used_for_rent',
  // Agent float (company money, not an expense)
  'agent_float_deposit',
  'agent_float_settlement',
  'agent_float_funding',
  'agent_float_topup',
  'agent_float_used_for_rent',
  'agent_landlord_payout',
  // Rent facilitation principal
  'rent_disbursement',
  'rent_repayment',
  'tenant_repayment',
  'tenant_repayment_collected',
  'agent_repayment',
  'rent_principal_collected',
  'rent_receivable_created',
  'rent_facilitation_payout',
  'pool_rent_deployment',
  'loan_repayment',
  'advance_repayment',
  'credit_access_repayment',
  'credit_access_draw',
  'listing_rejection_recovery',
  // Capital & financing
  'partner_funding',
  'pending_portfolio_topup',
  'roi_reinvestment',
  'pool_capital_received',
  'share_capital',
  'supporter_facilitation_capital',
  'supporter_capital_withdrawal',
  // Technical / corrections
  'opening_balance',
  'balance_correction',
  'historical_balance_reseed',
  'system_balance_correction',
  'orphan_reassignment',
  'orphan_reversal',
  'manager_credit',
  'cfo_direct_credit',
  // Treasury cash routing - company cash moving between locations, never a
  // revenue or expense event.
  'cash_receipt_in_transit',              // A5 Cash in Transit
  'cash_in_transit_banked',               // A5 Cash in Transit
  'treasury_bank_deposit',                // A1 Cash and Bank Balances
  'cash_at_bank_reclass',                 // A1 Cash and Bank Balances
  'agent_float_assignment',               // A1 Cash and Bank Balances
  'agent_float_cash_offset',              // A2 Cash at Hand - Float with Agents
  // Custody liabilities and receivables.
  'cash_custody_payable',                 // L1 Wallet Custody Payable
  'agent_facilitated_capital_receivable', // A2 Cash at Hand - Float with Agents
  'landlord_receivable_obligation',       // L4 Landlord Rent Payable
  'landlord_receivable_collected',        // A6 Landlord Product Receivables
  // Partner capital.
  'partner_capital_cash_received',        // A1 Cash and Bank Balances
  'partner_receivable_capital',           // L2 Partner Portfolios - Capital Held
  // L7 deferred-fee liability control. NOT revenue despite the name: the
  // recognised leg credits L7 (liability up when a plan is funded) and the
  // drawdown leg debits L7 (liability released as the fee is earned). The
  // revenue itself posts to R1 via access_fee_collected /
  // registration_fee_collected, already classified above - treating either L7
  // leg as revenue would double count the fee.
  'treasury_fee_recognised',              // L7 Platform Treasury Control
  'treasury_fee_drawdown',                // L7 Platform Treasury Control
  // NOT LISTED - 'treasury_net_revenue'. See CONTRA_REVENUE_CATEGORIES below:
  // it is a revenue deduction, not a non-P&L item.
];

/**
 * Contra-revenue: categories that map to R1 Platform Revenue but whose leg
 * DEBITS revenue (debit_when 'cash_in'), i.e. they REDUCE revenue rather than
 * earn it. Presented as a deduction under Revenue by Welile Service, never as
 * an expense (which would understate revenue and overstate cost) and never in
 * the unmapped review queue.
 *
 * `treasury_net_revenue` is the BD-3 pricing subsidy: a discount granted on
 * priced fees, correctly shown as a deduction from gross service revenue.
 */
export const CONTRA_REVENUE_CATEGORIES = [
  'treasury_net_revenue',                 // R1 Platform Revenue (debit leg)
];

const revenueLookup = new Map<string, ServiceFamilyKey>();
REVENUE_SERVICE_FAMILIES.forEach(f => f.categories.forEach(c => revenueLookup.set(c, f.key)));
const marketingSet = new Set(MARKETING_EXPENSE_CATEGORIES);
const operatingSet = new Set(OPERATING_EXPENSE_CATEGORIES);
const nonPlSet = new Set(NON_PL_CATEGORIES);

export type CategoryBucket =
  | { kind: 'revenue'; family: ServiceFamilyKey }
  | { kind: 'marketing' }
  | { kind: 'operating' }
  | { kind: 'non_pl' }
  | { kind: 'unmapped' };

export function classifyLedgerCategory(category: string): CategoryBucket {
  const fam = revenueLookup.get(category);
  if (fam) return { kind: 'revenue', family: fam };
  if (marketingSet.has(category)) return { kind: 'marketing' };
  if (operatingSet.has(category)) return { kind: 'operating' };
  if (nonPlSet.has(category)) return { kind: 'non_pl' };
  return { kind: 'unmapped' };
}

/** Human label for a ledger category (used in traceable line items). */
export function prettyCategory(category: string): string {
  return category
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
