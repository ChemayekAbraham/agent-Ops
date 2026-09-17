/**
 * Staff loan schedule — 30% per month charged on the amount still owing.
 *
 * Principal is spread evenly over the chosen months; each month's charge is 30%
 * of the balance outstanding at the start of that month, so the charge falls as
 * the loan is repaid. Mirrors `staff_loan_accrue_interest()` in the database.
 */
export const STAFF_LOAN_MONTHLY_RATE = 0.3;
export const STAFF_LOAN_MAX_MONTHS = 12;

export interface StaffLoanMonth {
  month: number;
  openingBalance: number;
  charge: number;
  principal: number;
  due: number;
  closingBalance: number;
}

export interface StaffLoanSchedule {
  months: StaffLoanMonth[];
  totalCharge: number;
  totalRepayable: number;
  firstMonthDue: number;
  firstDaily: number;
}

export function staffLoanSchedule(principal: number, months: number): StaffLoanSchedule {
  const amount = Math.max(0, Math.round(Number(principal) || 0));
  const n = Math.max(1, Math.min(STAFF_LOAN_MAX_MONTHS, Math.round(Number(months) || 1)));
  const monthlyPrincipal = Math.ceil(amount / n);

  const rows: StaffLoanMonth[] = [];
  let balance = amount;
  let totalCharge = 0;

  for (let m = 1; m <= n; m += 1) {
    const opening = balance;
    const charge = Math.round(opening * STAFF_LOAN_MONTHLY_RATE);
    const principalPart = Math.min(monthlyPrincipal, opening);
    balance = Math.max(0, opening - principalPart);
    totalCharge += charge;
    rows.push({
      month: m,
      openingBalance: opening,
      charge,
      principal: principalPart,
      due: principalPart + charge,
      closingBalance: balance,
    });
    if (balance <= 0 && m < n) break;
  }

  const firstMonthDue = rows[0]?.due ?? 0;
  return {
    months: rows,
    totalCharge,
    totalRepayable: amount + totalCharge,
    firstMonthDue,
    firstDaily: Math.ceil(firstMonthDue / 30),
  };
}

export const MONTH_WORDS = [
  'One month', 'Two months', 'Three months', 'Four months', 'Five months', 'Six months',
  'Seven months', 'Eight months', 'Nine months', 'Ten months', 'Eleven months', 'Twelve months',
];
