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

// Event-based fixed bonuses (UGX)
export const EVENT_BONUSES = {
  rent_posted_listed: 1000,
  rent_landlord_verified: 4000,
  rent_request_posted: 5000,
  house_listed: 2000,
  tenant_replacement: 20000,
  subagent_registration: 10000,
} as const;

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
