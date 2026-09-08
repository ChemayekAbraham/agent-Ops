/**
 * Agent Advance Calculations
 * 33% monthly compound interest with variable repayment periods
 */

export const MONTHLY_RATE = 0.33;
export const REPAYMENT_PERIODS = [7, 14, 30, 60, 90] as const;
export type RepaymentPeriod = (typeof REPAYMENT_PERIODS)[number];

/** How often the agent repays. `daily` is the default flow. */
export type RepaymentFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export const REPAYMENT_FREQUENCIES: { value: RepaymentFrequency; label: string; days: number }[] = [
  { value: 'daily', label: 'Daily (default)', days: 1 },
  { value: 'weekly', label: 'Weekly', days: 7 },
  { value: 'biweekly', label: 'Bi-Weekly', days: 14 },
  { value: 'monthly', label: 'Monthly', days: 30 },
];

/** Days in one repayment period. Mirrors the SQL `advance_period_days`. */
export function periodDays(frequency: RepaymentFrequency = 'daily'): number {
  return REPAYMENT_FREQUENCIES.find((f) => f.value === frequency)?.days ?? 1;
}

export function frequencyLabel(frequency?: string | null): string {
  switch ((frequency || 'daily').toLowerCase()) {
    case 'weekly': return 'Weekly';
    case 'biweekly': return 'Bi-Weekly';
    case 'monthly': return 'Monthly';
    default: return 'Daily';
  }
}

/** Number of installments across the whole cycle for a given frequency. */
export function installmentCount(days: number, frequency: RepaymentFrequency = 'daily'): number {
  return Math.max(1, Math.ceil(days / periodDays(frequency)));
}

/** Amount due per repayment period (total ÷ installments). */
export function calculateInstallment(
  principal: number,
  days: number,
  monthlyRate: number = MONTHLY_RATE,
  frequency: RepaymentFrequency = 'daily',
): number {
  return Math.ceil(
    calculateTotalPayable(principal, days, monthlyRate) / installmentCount(days, frequency),
  );
}

export interface DayProjection {
  day: number;
  openingBalance: number;
  interestAccrued: number;
  closingBalance: number;
}

/**
 * Registration fee: UGX 10,000 if principal ≤ 200,000; UGX 20,000 if > 200,000
 */
export function calculateRegistrationFee(principal: number): number {
  return principal <= 200000 ? 10000 : 20000;
}

/**
 * Access fee: principal × (1.33^(days/30) - 1)
 */
export function calculateAccessFee(principal: number, days: number, monthlyRate: number = MONTHLY_RATE): number {
  return Math.round(principal * (Math.pow(1 + monthlyRate, days / 30) - 1));
}

/**
 * Access fee as the DATABASE computes it: simple pro-rata, principal × rate × days/30.
 *
 * `calculateAccessFee` above compounds. The two agree exactly at 30 days and diverge
 * everywhere else, and `disburse_agent_advance_request` / `cfo_create_advance` are the
 * authority — they always recompute with this formula before the money moves. Staff
 * issuance surfaces must preview with this one so the figure the operator confirms is
 * the figure that gets written.
 */
export function calculateAccessFeeSimple(principal: number, days: number, monthlyRate: number = MONTHLY_RATE): number {
  return Math.round(principal * monthlyRate * (days / 30));
}

/**
 * Total payable = principal + access fee + registration fee
 */
export function calculateTotalPayable(principal: number, days: number, monthlyRate: number = MONTHLY_RATE): number {
  return principal + calculateAccessFee(principal, days, monthlyRate) + calculateRegistrationFee(principal);
}

/**
 * Daily payment = total ÷ period days
 */
export function calculateDailyPayment(principal: number, days: number, monthlyRate: number = MONTHLY_RATE): number {
  return Math.ceil(calculateTotalPayable(principal, days, monthlyRate) / days);
}

/**
 * Day-by-day projection showing monthly compounding growth
 * Daily interest rate derived from monthly: (1.33^(1/30) - 1)
 */
export function calculateCompoundProjection(
  principal: number,
  days: number = 30,
  monthlyRate: number = MONTHLY_RATE
): DayProjection[] {
  const dailyRate = Math.pow(1 + monthlyRate, 1 / 30) - 1;
  const projections: DayProjection[] = [];
  let balance = principal;

  for (let day = 1; day <= days; day++) {
    const interest = Math.round(balance * dailyRate);
    const newBalance = balance + interest;

    projections.push({
      day,
      openingBalance: balance,
      interestAccrued: interest,
      closingBalance: newBalance,
    });

    balance = newBalance;
  }

  return projections;
}

export function getRiskLevel(advance: {
  outstanding_balance: number;
  principal: number;
  status: string;
}): 'green' | 'yellow' | 'red' {
  if (advance.status === 'overdue') return 'red';
  if (advance.status === 'completed') return 'green';
  const ratio = advance.outstanding_balance / Math.max(advance.principal, 1);
  if (ratio > 3) return 'red';
  if (ratio > 1.5) return 'yellow';
  return 'green';
}

import { formatDynamic } from '@/lib/currencyFormat';

export function formatUGX(amount: number): string {
  return formatDynamic(amount);
}
