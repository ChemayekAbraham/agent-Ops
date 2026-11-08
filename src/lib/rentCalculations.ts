// Rent calculation utilities for the platform
import { monthlyReturnFor, rateOrNull } from './partnerReturnPolicy';

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
 *
 * The agent commission dropped to 8% at go-live, but the tenant's price did
 * not change: this floor (and its /0.90) is deliberately left as it was.
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
 * Calculate instalment amount for a given period
 */
export function calculateInstalment(totalRepayment: number, durationDays: number, periodDays: number): { amount: number; count: number } {
  const count = Math.max(1, Math.ceil(durationDays / periodDays));
  const amount = Math.ceil(totalRepayment / count);
  return { amount, count };
}

// Commission engine constants.
//
// Rent-collection commission is 8% of every collection on every Rent Plan
// (10% until the 8% go-live). The server is authoritative:
// `get_agent_commission_rate(p_agent_id)` / `get_my_commission_rate()` return
// the rate that is actually paid, and `useMyCommissionRate` reads it. These
// constants are display fallbacks and must stay in step with that function.
//
//   Agent with no parent ............ 8%
//   Sub-agent with a verified parent  6% to the sub-agent + 2% to the parent
//   Whitelisted / elite sub-agent ... the full 8%, parent gets nothing
//
// The tenant's price does not change (see calculateAccessFeeFloor above).
export const AGENT_COMMISSION_RATE = 0.08;     // Total agent commission: 8% of each collection
export const SUBAGENT_COMMISSION_RATE = 0.06;  // Sub-agent's share when a verified parent exists
export const PARENT_OVERRIDE_RATE = 0.02;      // Parent (recruiter) override on a sub-agent's collection

export const COMMISSION_RATE = AGENT_COMMISSION_RATE;   // Total commission: 8% of repayment
export const SOURCE_RATE = 0.02;                        // Source (onboarding) agent: 2%
export const MANAGER_RATE = SUBAGENT_COMMISSION_RATE;   // Tenant manager: 6%
export const RECRUITER_RATE = PARENT_OVERRIDE_RATE;     // Recruiter override: 2% (sub-agent keeps 6%)

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
 * Calculate total agent commission from repayment (8%)
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
 *
 * @deprecated A hard-coded 15%. After the Partner Returns switch-on a new partner's reward rate is
 * the new-partner rate and an existing partner keeps their own, so use calculateSupporterRewardAt
 * with the person's own rate (useOwnNewPortfolioRate on signed-in supporter screens). Kept only so
 * today's screens behave as they do until they move over; must have no importer at release
 * (design v2 §8.5 #3; release gate and release scan).
 */
export function calculateSupporterReward(rentAmount: number): number {
  return Math.round(rentAmount * 0.15);
}

/**
 * The monthly rent-facilitation reward on `rentAmount` at `ratePct` (monthly %, e.g. 10), rounded as
 * the database pays it (round(rent * rate / 100)). `ratePct` comes from the database: the signed-in
 * supporter's own rate (useOwnNewPortfolioRate, partner_quote_rate('me'), the rule the funding stamps
 * into rent_facilitation_reward_rates). No rate, or a rent that is not a number, gives null: show no
 * figure, never a default rate.
 */
export function calculateSupporterRewardAt(rentAmount: unknown, ratePct: number | null): number | null {
  return monthlyReturnFor(rentAmount, ratePct);
}

/**
 * The total reward on several rent requests at `ratePct`: each request is rounded on its own, as each
 * is paid, so the total equals the sum of calculateSupporterRewardAt. A request whose rent is not a
 * number adds nothing. null when the rate is unknown.
 */
export function sumSupporterRewardsAt(rentAmounts: Iterable<unknown>, ratePct: number | null): number | null {
  if (rateOrNull(ratePct) === null) return null;
  let total = 0;
  for (const rent of rentAmounts) total += calculateSupporterRewardAt(rent, ratePct) ?? 0;
  return total;
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

/**
 * formatUGX for a figure this viewer may not know: a Returns figure masked by Partner Returns 4b (null),
 * or a figure priced at a rate the database did not give. Unknown shows '—', never a 0 amount
 * (formatUGX(null) prints 0).
 */
export function formatUGXOrDash(amount: number | null | undefined): string {
  return typeof amount === 'number' && Number.isFinite(amount) ? formatUGX(amount) : '—';
}
