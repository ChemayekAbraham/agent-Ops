export type Frequency = "daily" | "weekly" | "monthly" | "once" | "end_of_month";

const DAY_MS = 86_400_000;

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDay(value: string | Date): Date {
  const text = value instanceof Date ? ymd(value) : value.slice(0, 10);
  return new Date(`${text}T00:00:00.000Z`);
}

function lastDayOfMonth(year: number, monthIdx: number): Date {
  return new Date(Date.UTC(year, monthIdx + 1, 0));
}

export function firstDeductionDate(
  startedAt: string,
  expectedRepaymentDate: string | null,
  frequency: Frequency,
): string {
  const start = parseDay(startedAt);
  switch (frequency) {
    case "daily":
      start.setUTCDate(start.getUTCDate() + 1);
      return ymd(start);
    case "weekly":
      start.setUTCDate(start.getUTCDate() + 7);
      return ymd(start);
    case "monthly":
      start.setUTCMonth(start.getUTCMonth() + 1);
      return ymd(start);
    case "end_of_month":
      return ymd(lastDayOfMonth(start.getUTCFullYear(), start.getUTCMonth()));
    case "once":
    default:
      return expectedRepaymentDate || ymd(start);
  }
}

export function nextDeductionDate(from: string | Date, frequency: Frequency): string | null {
  const d = parseDay(from);
  switch (frequency) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      return ymd(d);
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      return ymd(d);
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      return ymd(d);
    case "end_of_month":
      return ymd(lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1));
    case "once":
    default:
      return null;
  }
}

export function scheduledDatesThrough(
  firstDate: string,
  throughDate: string,
  expectedRepaymentDate: string | null,
  frequency: Frequency,
): string[] {
  const through = parseDay(throughDate);
  const contractualEnd = expectedRepaymentDate ? parseDay(expectedRepaymentDate) : through;
  const end = contractualEnd < through ? contractualEnd : through;
  const dates: string[] = [];
  let cursor: string | null = firstDate;
  let guard = 0;

  while (cursor && parseDay(cursor) <= end && guard < 3660) {
    dates.push(cursor);
    cursor = nextDeductionDate(cursor, frequency);
    guard += 1;
  }
  return dates;
}

export function unpaidScheduledDates(
  scheduledDates: string[],
  installment: number,
  amountRepaid: number,
  totalOwed: number,
): string[] {
  if (installment <= 0 || totalOwed <= 0) return [];
  let paidRemaining = Math.max(0, amountRepaid);
  let scheduledRemaining = totalOwed;
  const unpaid: string[] = [];

  for (const date of scheduledDates) {
    const due = Math.min(installment, scheduledRemaining);
    if (due <= 0) break;
    if (paidRemaining >= due) paidRemaining -= due;
    else {
      unpaid.push(date);
      paidRemaining = 0;
    }
    scheduledRemaining -= due;
  }
  return unpaid;
}

export function overdueAmount(
  scheduledCount: number,
  installment: number,
  amountRepaid: number,
  totalOwed: number,
): number {
  const expectedByNow = Math.min(totalOwed, scheduledCount * installment);
  return Math.max(0, Math.round(expectedByNow - Math.max(0, amountRepaid)));
}

export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.floor((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS));
}