/**
 * Merchandise instalment pricing — reducing balance, same model as the phone plan.
 *
 * Monthly principal = product amount / months (remainder falls on the last month).
 * Monthly charge    = 28% of the OPENING outstanding principal for that month.
 * Monthly due       = monthly principal + monthly charge.
 * Daily deduction   = that month's due / days in that repayment month.
 *
 * Because the charge follows the shrinking principal, the monthly due and the
 * daily wallet deduction both fall over the life of the plan.
 */
import {
  smartphoneReducingSchedule,
  type SmartphoneReducingSchedule,
  type SmartphoneMonthRow,
} from '@/lib/smartphoneAdvance';

export type MerchandiseMonthRow = SmartphoneMonthRow;
export type MerchandiseInstallmentSchedule = SmartphoneReducingSchedule;

/** Selectable repayment periods — one month up to a full year. */
export const MERCHANDISE_TERMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** Full month-by-month schedule for a product amount over a chosen period. */
export function merchandiseInstallmentSchedule(
  amount: number,
  months: number,
  startDate?: string | Date,
): MerchandiseInstallmentSchedule {
  return smartphoneReducingSchedule(amount, months, startDate);
}
