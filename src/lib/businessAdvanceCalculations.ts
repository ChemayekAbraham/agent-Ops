/**
 * Business Advance — 1% per day compounding on outstanding balance.
 * Open-ended: tenant pays whatever, whenever; interest compounds daily.
 *
 * Daily commission: 4% of every repayment, paid to the originating agent
 * as a platform expense (general_admin_expense).
 */

export const BUSINESS_ADVANCE_DAILY_RATE = 0.01; // 1% per day
export const AGENT_COMMISSION_RATE = 0.04; // 4% per repayment

import { formatDynamic } from '@/lib/currencyFormat';

export function formatUGX(amount: number): string {
  return formatDynamic(amount);
}

/**
 * Project the outstanding balance forward N days at 1% daily compounding.
 * Used by the calculator preview before the advance is issued.
 */
export function projectOutstanding(principal: number, days: number, rate = BUSINESS_ADVANCE_DAILY_RATE): number {
  if (principal <= 0 || days <= 0) return principal;
  return Math.round(principal * Math.pow(1 + rate, days));
}

/**
 * Compute the agent's commission for a single repayment.
 */
export function calculateAgentCommission(repaymentAmount: number, rate = AGENT_COMMISSION_RATE): number {
  return Math.round(repaymentAmount * rate);
}

/**
 * Day-by-day projection used in the preview/quote screen.
 */
export interface BAProjection {
  day: number;
  openingBalance: number;
  interestAccrued: number;
  closingBalance: number;
}

export function projectBusinessAdvance(principal: number, days: number, rate = BUSINESS_ADVANCE_DAILY_RATE): BAProjection[] {
  const out: BAProjection[] = [];
  let balance = principal;
  for (let day = 1; day <= days; day++) {
    const interest = Math.round(balance * rate);
    const closing = balance + interest;
    out.push({ day, openingBalance: balance, interestAccrued: interest, closingBalance: closing });
    balance = closing;
  }
  return out;
}

export const BUSINESS_TYPES = [
  'Retail shop',
  'Wholesale / distribution',
  'Restaurant / food vendor',
  'Salon / barbershop',
  'Boda boda / transport',
  'Tailoring / garments',
  'Hardware / construction supplies',
  'Mobile money agent',
  'Farming / agriculture',
  'Services (other)',
] as const;
