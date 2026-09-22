/**
 * Staff loan schedule — mirrors the database exactly.
 *
 * Interest is fixed at origination. The rate and the method are always supplied
 * by the caller (from `my_staff_loan_eligibility` or the stored loan row) — this
 * file never assumes a rate.
 */

export interface StaffLoanInstalment {
  seq: number;
  dueOn: string;
  amount: number;
}

export interface StaffLoanSchedule {
  interest: number;
  totalRepayable: number;
  instalments: StaffLoanInstalment[];
}

/** Instalment n falls due on the 26th of the nth month after the current month. */
function dueOnFor(seq: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + seq, 26);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-26`;
}

export function staffLoanSchedule(
  principal: number,
  months: number,
  monthlyRate: number,
  interestMethod: 'flat' | 'compound',
): StaffLoanSchedule {
  const amount = Math.max(0, Math.round(Number(principal) || 0));
  const n = Math.max(1, Math.round(Number(months) || 1));
  const rate = Number(monthlyRate) || 0;

  const interest = interestMethod === 'flat'
    ? Math.round(amount * rate * n)
    : Math.round(amount * (Math.pow(1 + rate, n) - 1));

  const totalRepayable = amount + interest;
  const instalment = Math.floor(totalRepayable / n);
  const lastInstalment = totalRepayable - instalment * (n - 1);

  const instalments: StaffLoanInstalment[] = [];
  for (let seq = 1; seq <= n; seq += 1) {
    instalments.push({
      seq,
      dueOn: dueOnFor(seq),
      amount: seq === n ? lastInstalment : instalment,
    });
  }

  return { interest, totalRepayable, instalments };
}

export const MONTH_WORDS = [
  'One month', 'Two months', 'Three months', 'Four months', 'Five months', 'Six months',
  'Seven months', 'Eight months', 'Nine months', 'Ten months', 'Eleven months', 'Twelve months',
];
