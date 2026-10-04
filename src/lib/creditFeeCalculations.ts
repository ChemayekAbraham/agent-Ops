// Credit request fee calculations
// 5% platform fee compounding monthly

const MONTHLY_PLATFORM_RATE = 0.05; // 5% per month

/**
 * Calculate compounding 5% monthly platform fee
 */
export function calculatePlatformFee(amount: number, durationDays: number): number {
  const months = durationDays / 30;
  const rate = Math.pow(1 + MONTHLY_PLATFORM_RATE, months) - 1;
  return Math.round(amount * rate);
}

/**
 * Calculate full repayment breakdown for credit request
 */
export function calculateCreditRepayment(
  amount: number,
  durationDays: number,
  funderInterestRate: number = 0
) {
  const platformFee = calculatePlatformFee(amount, durationDays);
  const funderInterest = Math.round(amount * (funderInterestRate / 100));
  const totalRepayment = amount + platformFee + funderInterest;

  const dailyRepayment = Math.ceil(totalRepayment / durationDays);
  const weeklyRepayment = Math.ceil(totalRepayment / Math.ceil(durationDays / 7));
  const monthlyRepayment = Math.ceil(totalRepayment / Math.ceil(durationDays / 30));

  const platformFeePercent = ((platformFee / amount) * 100).toFixed(1);

  return {
    amount,
    durationDays,
    platformFee,
    platformFeePercent,
    funderInterest,
    funderInterestRate,
    totalRepayment,
    dailyRepayment,
    weeklyRepayment,
    monthlyRepayment,
  };
}

import { formatDynamic } from '@/lib/currencyFormat';

export function formatUGX(amount: number): string {
  return formatDynamic(amount);
}
