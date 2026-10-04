// Shared helpers for the Lending Agent portal — keeps the smartphone UI logic lean.

export interface LendingLoan {
  id: string;
  borrower_ai_id: string;
  borrower_display_name: string | null;
  borrower_phone?: string | null;
  principal_ugx: number;
  interest_rate_pct: number | null;
  amount_repaid_ugx: number;
  status: string;
  expected_repayment_date: string | null;
  created_at: string;
  platform_fee_ugx: number;
  repayment_frequency?: string | null;
  auto_deduct_enabled?: boolean | null;
  installment_ugx?: number | null;
  next_deduction_date?: string | null;
}

/** Normalize a Ugandan phone number to international (256...) digits for tel/wa/sms links. */
export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('0')) digits = '256' + digits.slice(1);
  else if (digits.startsWith('256')) { /* already international */ }
  else if (digits.length === 9) digits = '256' + digits; // 7XXXXXXXX
  return digits.length >= 9 ? digits : null;
}

/** Total amount the borrower still owes on this loan (principal + interest − repaid). */
export function outstandingOf(loan: LendingLoan): number {
  const interest = (loan.principal_ugx * (Number(loan.interest_rate_pct) || 0)) / 100;
  const owed = loan.principal_ugx + interest - (Number(loan.amount_repaid_ugx) || 0);
  return Math.max(0, Math.round(owed));
}

export type DueState = 'overdue' | 'due_today' | 'due_soon' | 'upcoming' | 'none';

export function dueStateOf(loan: LendingLoan): DueState {
  if (loan.status === 'repaid' || loan.status === 'defaulted') return 'none';
  if (!loan.expected_repayment_date) return 'none';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(loan.expected_repayment_date); due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'due_today';
  if (diffDays <= 3) return 'due_soon';
  return 'upcoming';
}

export interface LendingStats {
  totalDisbursed: number;
  totalOutstanding: number;
  activeCount: number;
  dueTodayCount: number;
  overdueCount: number;
  repaidCount: number;
  defaultedCount: number;
  defaultRatePct: number;
  collectedThisMonth: number;
}

export function computeStats(loans: LendingLoan[]): LendingStats {
  let totalDisbursed = 0, totalOutstanding = 0;
  let activeCount = 0, dueTodayCount = 0, overdueCount = 0, repaidCount = 0, defaultedCount = 0;
  for (const loan of loans) {
    totalDisbursed += loan.principal_ugx;
    const isOpen = loan.status === 'active' || loan.status === 'partially_repaid';
    if (isOpen) { activeCount += 1; totalOutstanding += outstandingOf(loan); }
    if (loan.status === 'repaid') repaidCount += 1;
    if (loan.status === 'defaulted') defaultedCount += 1;
    const ds = dueStateOf(loan);
    if (ds === 'due_today') dueTodayCount += 1;
    if (ds === 'overdue') overdueCount += 1;
  }
  const decided = repaidCount + defaultedCount;
  const defaultRatePct = decided > 0 ? Math.round((defaultedCount / decided) * 100) : 0;
  return {
    totalDisbursed, totalOutstanding, activeCount, dueTodayCount,
    overdueCount, repaidCount, defaultedCount, defaultRatePct,
    collectedThisMonth: 0,
  };
}

export type StatusFilter = 'all' | 'due_today' | 'overdue' | 'active' | 'repaid';

export function matchesFilter(loan: LendingLoan, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'active': return loan.status === 'active' || loan.status === 'partially_repaid';
    case 'repaid': return loan.status === 'repaid';
    case 'due_today': return dueStateOf(loan) === 'due_today';
    case 'overdue': return dueStateOf(loan) === 'overdue';
    default: return true;
  }
}

export function matchesSearch(loan: LendingLoan, q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return (
    (loan.borrower_display_name ?? '').toLowerCase().includes(needle) ||
    (loan.borrower_ai_id ?? '').toLowerCase().includes(needle) ||
    (loan.borrower_phone ?? '').toLowerCase().includes(needle)
  );
}

// ===== Auto-deduction repayment schedule =====

export type RepaymentFrequency = 'daily' | 'weekly' | 'monthly' | 'once' | 'end_of_month';

export const REPAYMENT_FREQUENCIES: { value: RepaymentFrequency; label: string; hint: string }[] = [
  { value: 'daily', label: 'Daily', hint: 'Pull a slice every day' },
  { value: 'weekly', label: 'Weekly', hint: 'Pull once every 7 days' },
  { value: 'monthly', label: 'Monthly', hint: 'Pull once a month' },
  { value: 'end_of_month', label: 'End of month', hint: 'Pull on the last day of each month' },
  { value: 'once', label: 'Once (lump sum)', hint: 'Pull the whole balance one time' },
];

function lastDayOfMonth(year: number, monthIdx: number): Date {
  return new Date(year, monthIdx + 1, 0);
}

function diffDays(a: Date, b: Date): number {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

/** Count how many month-ends fall in (start, due]. */
function countMonthEnds(start: Date, due: Date): number {
  let count = 0;
  const cursor = lastDayOfMonth(start.getFullYear(), start.getMonth());
  while (cursor <= due) {
    if (cursor > start) count += 1;
    cursor.setMonth(cursor.getMonth() + 1);
    // re-snap to month end after month increment
    cursor.setDate(0);
    cursor.setMonth(cursor.getMonth() + 1);
    cursor.setDate(0);
  }
  return Math.max(1, count);
}

/** Number of installments for a cadence over a [start, due] window. */
export function periodsFor(freq: RepaymentFrequency, start: Date, due: Date): number {
  if (freq === 'once' || due <= start) return 1;
  const days = diffDays(start, due);
  switch (freq) {
    case 'daily': return Math.max(1, days);
    case 'weekly': return Math.max(1, Math.ceil(days / 7));
    case 'monthly': return Math.max(1, Math.ceil(days / 30));
    case 'end_of_month': return countMonthEnds(start, due);
    default: return 1;
  }
}

/** First deduction date for a cadence starting from `start`. */
export function firstDeductionDate(freq: RepaymentFrequency, start: Date, due: Date): string {
  const d = new Date(start.getTime());
  const fmt = (x: Date) => {
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  switch (freq) {
    case 'daily': d.setDate(d.getDate() + 1); return fmt(d);
    case 'weekly': d.setDate(d.getDate() + 7); return fmt(d);
    case 'monthly': d.setMonth(d.getMonth() + 1); return fmt(d);
    case 'end_of_month': return fmt(lastDayOfMonth(d.getFullYear(), d.getMonth()));
    case 'once': return fmt(due > start ? due : d);
    default: return fmt(d);
  }
}

export interface ScheduleResult {
  installment: number;
  periods: number;
  firstDate: string;
}

/** Even split of total owed across the cadence's periods within the loan window. */
export function buildSchedule(
  totalOwed: number,
  freq: RepaymentFrequency,
  startDate: Date,
  dueDateStr: string | null,
): ScheduleResult {
  const due = dueDateStr ? new Date(dueDateStr) : new Date(startDate.getTime() + 30 * 86400000);
  const periods = periodsFor(freq, startDate, due);
  const installment = Math.max(1, Math.ceil(totalOwed / periods));
  return { installment, periods, firstDate: firstDeductionDate(freq, startDate, due) };
}
