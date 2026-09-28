// Rent calculation utilities for the platform

export interface RentCalculation {
  rentAmount: number;
  durationDays: number;
  accessFee: number;
  requestFee: number;
  totalRepayment: number;
  dailyRepayment: number;
  accessFeeRate: number;
}

// Constants - supported access fee rates
export const ACCESS_FEE_RATES = [
  { rate: 0.23, label: '23%' },
  { rate: 0.28, label: '28%' },
  { rate: 0.33, label: '33%' },
] as const;

const DEFAULT_MONTHLY_COMPOUND_RATE = 0.33; // 33% per month

/**
 * Calculate access fee based on duration and chosen monthly rate
 * Compounding per month, supports any number of days
 */
export function calculateAccessFee(rentAmount: number, durationDays: number, monthlyRate: number = DEFAULT_MONTHLY_COMPOUND_RATE): number {
  const months = durationDays / 30;
  const rate = Math.pow(1 + monthlyRate, months) - 1;
  return Math.round(rentAmount * rate);
}

/**
 * Calculate request fee based on rent amount
 * UGX 10,000 for rent <= 200,000
 * UGX 20,000 for rent > 200,000
 */
export function calculateRequestFee(rentAmount: number): number {
  return rentAmount <= 200000 ? 10000 : 20000;
}

/**
 * BD-4 minimum access fee floor.
 *
 *   floor = [principal x (0.005 x days + 0.10) + 0.10 x registration] / 0.90
 *
 * Below roughly 24 days the 1.33 compounding curve does not cover the 10% agent
 * commission (charged on total repayment, so it tracks principal rather than
 * tenor) plus the 15% partner reward. This mirrors compute_rent_repayment() in
 * the database exactly; the database is authoritative and enforces it via
 * trg_enforce_rent_request_formula. Keep the two in step.
 */
export function calculateAccessFeeFloor(rentAmount: number, durationDays: number): number {
  const requestFee = calculateRequestFee(rentAmount);
  return Math.ceil((rentAmount * (0.005 * durationDays + 0.10) + 0.10 * requestFee) / 0.90);
}

/**
 * Calculate all rent repayment details
 * Supports any duration from 7-120 days
 */
export function calculateRentRepayment(rentAmount: number, durationDays: number, monthlyRate: number = 0.33): RentCalculation {
  const curveFee = calculateAccessFee(rentAmount, durationDays, monthlyRate);
  const accessFee = Math.max(curveFee, calculateAccessFeeFloor(rentAmount, durationDays));
  const requestFee = calculateRequestFee(rentAmount);
  const totalRepayment = rentAmount + accessFee + requestFee;
  const dailyRepayment = Math.ceil(totalRepayment / durationDays);
  const accessFeeRate = (accessFee / rentAmount) * 100;

  return {
    rentAmount,
    durationDays,
    accessFee,
    requestFee,
    totalRepayment,
    dailyRepayment,
    accessFeeRate
  };
}

/**
 * Partner (Supporter) reward carried inside a Rent Plan's Access Fee:
 * 15% of the principal per 30 days. Mirrors v_plan_partner in
 * post_instalment_waterfall(). Capped at the Access Fee it is paid from.
 */
export function calculatePlanPartnerReward(rentAmount: number, durationDays: number, accessFee: number): number {
  return Math.min(Math.round(rentAmount * 0.15 * (durationDays / 30)), Math.max(0, accessFee));
}

export interface RepaymentShare {
  /** Share of the given installment (or of the whole repayment), UGX to 2 dp. */
  amount: number;
  /** Share of total repayment, percent to 2 dp. */
  percent: number;
}

export interface RepaymentBreakdown {
  /** Goes back to the landlord float. */
  principal: RepaymentShare;
  /** Access Fee = partnerReward + agentCommission + platformFee. */
  accessFee: RepaymentShare;
  partnerReward: RepaymentShare;
  /** 10% of every installment, paid to agents out of the Access Fee. */
  agentCommission: RepaymentShare;
  /**
   * What the platform keeps from the Access Fee after the partner reward and
   * agent commission. Negative on plans too short for the Access Fee to cover
   * both (a pricing subsidy, as in post_instalment_waterfall).
   */
  platformFee: RepaymentShare;
  registrationFee: RepaymentShare;
  /** The amount being split. */
  total: number;
}

/**
 * Break a Rent Plan repayment into percentages of total repayment, and apply
 * them to one installment (defaults to the daily installment).
 *
 *   100,000 / 30 days -> total 143,000
 *     principal         100,000  69.93%   (landlord float)
 *     access fee         33,000  23.08%
 *       partner reward   15,000  10.49%
 *       agent commission 14,300  10.00%   (10% of every installment)
 *       platform fee      3,700   2.59%
 *     registration fee   10,000   6.99%
 *
 * Installment amounts are rounded to 2 dp; the principal absorbs the rounding
 * so the parts always add up to the installment. The whole-shilling split
 * actually posted to the ledger is compute_instalment_allocation() in the DB.
 */
export function calculateRepaymentBreakdown(
  calc: RentCalculation,
  installment: number = calc.dailyRepayment,
): RepaymentBreakdown {
  const total = calc.totalRepayment;
  const partner = calculatePlanPartnerReward(calc.rentAmount, calc.durationDays, calc.accessFee);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const share = (part: number): RepaymentShare =>
    total > 0
      ? { amount: r2((installment * part) / total), percent: r2((part / total) * 100) }
      : { amount: 0, percent: 0 };

  const commission = total * COMMISSION_RATE;
  const partnerReward = share(partner);
  const agentCommission = share(commission);
  const platformFee = share(calc.accessFee - partner - commission);
  const registrationFee = share(calc.requestFee);
  const accessFee = {
    amount: r2(partnerReward.amount + agentCommission.amount + platformFee.amount),
    percent: share(calc.accessFee).percent,
  };
  const principal = {
    amount: r2(installment - accessFee.amount - registrationFee.amount),
    percent: share(calc.rentAmount).percent,
  };

  return { principal, accessFee, partnerReward, agentCommission, platformFee, registrationFee, total: installment };
}

/**
 * Calculate instalment amount for a given period
 */
export function calculateInstalment(totalRepayment: number, durationDays: number, periodDays: number): { amount: number; count: number } {
  const count = Math.max(1, Math.ceil(durationDays / periodDays));
  const amount = Math.ceil(totalRepayment / count);
  return { amount, count };
}

// Commission engine constants
export const COMMISSION_RATE = 0.10;       // Total commission: 10% of repayment
export const SOURCE_RATE = 0.02;           // Source (onboarding) agent: 2%
export const MANAGER_RATE = 0.08;          // Tenant manager: 8%
export const RECRUITER_RATE = 0.02;        // Recruiter override: 2% (manager drops to 6%)

// Event-based fixed bonuses (UGX).
//
// Every entry names the backend path that actually pays it. Nothing is listed
// here that does not pay — four entries were removed on 2026-09-25 because
// they had never paid a shilling (their event keys were not recognised by
// `credit_agent_event_bonus`) and their triggers have since been dropped:
// rent_posted_listed (1,000), rent_landlord_verified (4,000),
// rent_request_posted (5,000) and tenant_replacement (20,000).
// See docs/rent-plan-new-flow-full-report.md.
export const EVENT_BONUSES = {
  /** credit_agent_event_bonus('contact_location_capture') — once per agent per contact */
  contact_location_capture: 100,
  /** credit_agent_event_bonus('house_listed') — via credit-listing-bonus */
  house_listed: 2000,
  /** pay_landlord_registration_verified_bonus — once per NEW landlord, ever */
  landlord_verified: 5000,
  /** pay_lc1_registration_verified_bonus — once per NEW LC1 chairperson */
  lc1_verified: 2000,
  /** credit_agent_event_bonus('subagent_registration') */
  subagent_registration: 10000,
  /** credit_agent_event_bonus('three_verified_houses') */
  three_verified_houses: 10000,
  /** credit_agent_event_bonus('tenant_placement') */
  tenant_placement: 10000,
  /** credit_agent_event_bonus('service_centre_setup') */
  service_centre_setup: 25000,
} as const;

/**
 * Recruiter override paid to the parent agent, by
 * `pay_recruiter_override_house_verified`. House listings only — the landlord
 * and LC1 verification overrides were removed on 2026-09-25; that money is now
 * solely the registering agent's.
 */
export const RECRUITER_VERIFICATION_OVERRIDE = 2000;

/**
 * Paid to the agent when the landlord float leaves their wallet, by
 * `post_landlord_payout_finops_commission`. This replaced the flat bonuses that
 * used to be paid when the CFO funded the float — nothing is earned for
 * receiving the money, only for delivering it.
 */
export const LANDLORD_PAYOUT_COMMISSION_RATE = 0.01;

export type CommissionEventType = keyof typeof EVENT_BONUSES;

/**
 * Calculate total agent commission from repayment (10%)
 */
export function calculateAgentCommission(repaidAmount: number): number {
  return Math.round(repaidAmount * COMMISSION_RATE);
}

/**
 * Calculate commission split for a repayment
 */
export function calculateCommissionSplit(repaidAmount: number, options: {
  sameAgent: boolean;
  hasRecruiter: boolean;
}): { source: number; manager: number; recruiter: number } {
  const total = calculateAgentCommission(repaidAmount);

  if (options.sameAgent) {
    if (options.hasRecruiter) {
      const manager = Math.round(repaidAmount * MANAGER_RATE);
      return { source: 0, manager, recruiter: total - manager };
    }
    return { source: 0, manager: total, recruiter: 0 };
  }

  const source = Math.round(repaidAmount * SOURCE_RATE);
  if (options.hasRecruiter) {
    const recruiter = Math.round(repaidAmount * RECRUITER_RATE);
    return { source, manager: total - source - recruiter, recruiter };
  }
  return { source, manager: total - source, recruiter: 0 };
}

/**
 * Calculate supporter reward
 * 15% of rent facilitation
 */
export function calculateSupporterReward(rentAmount: number): number {
  return Math.round(rentAmount * 0.15);
}

/**
 * Agent approval bonus per approved request
 */
export const AGENT_APPROVAL_BONUS = 5000;

import { formatDynamic } from '@/lib/currencyFormat';

/**
 * Format currency in the user's selected currency (dynamic).
 * Kept as `formatUGX` for backward compatibility — all existing call sites
 * will now automatically use the selected currency.
 */
export function formatUGX(amount: number): string {
  return formatDynamic(amount);
}
