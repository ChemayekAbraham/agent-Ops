import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { smartphoneReducingSchedule, SMARTPHONE_MONTHLY_CHARGE_PCT } from '@/lib/smartphoneAdvance';

/**
 * Read-only repayment duration and month-by-month schedule for one smartphone
 * application, rebuilt from the stored terms with the same shared calculator
 * the order form uses. Nothing is decided or written here.
 */
export interface SmartphoneRepaymentBreakdownProps {
  /** Device / down-payment amount the charge is calculated on. */
  amount: number | null | undefined;
  /** Recorded repayment period in months. */
  months: number | null | undefined;
  /** Day the repayments start, if recorded. */
  startsOn?: string | null;
  /** Total repayable as stored on the order, shown when it differs. */
  storedTotalRepayable?: number | null;
  /** Days as stored on the order. */
  storedDays?: number | null;
  className?: string;
}

const day = (v: string) => {
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? v : format(d, 'dd MMM');
};

export function SmartphoneRepaymentBreakdown({
  amount,
  months,
  startsOn,
  storedTotalRepayable,
  storedDays,
  className,
}: SmartphoneRepaymentBreakdownProps) {
  const base = Math.max(0, Math.round(Number(amount || 0)));
  const term = Math.max(0, Math.round(Number(months || 0)));

  if (base <= 0 || term <= 0) {
    return (
      <div className={`rounded-lg border p-3 ${className ?? ''}`}>
        <p className="text-xs font-semibold">Repayment schedule</p>
        <p className="text-[11px] text-muted-foreground">
          No repayment period is recorded on this application yet, so no schedule can be shown.
        </p>
      </div>
    );
  }

  const s = smartphoneReducingSchedule(base, term, startsOn ?? undefined);
  const total = Number(storedTotalRepayable || 0) > 0 ? Number(storedTotalRepayable) : s.totalRepayable;
  const days = Number(storedDays || 0) > 0 ? Number(storedDays) : s.days;

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">Repayment duration &amp; schedule</p>
        <span className="text-[10px] text-muted-foreground">
          {SMARTPHONE_MONTHLY_CHARGE_PCT}% monthly, reducing balance
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">Duration</p>
          <p className="text-xs font-semibold">
            {s.months} month{s.months === 1 ? '' : 's'} · {days} days
          </p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">Amount financed</p>
          <p className="text-xs font-semibold tabular-nums">{formatUGX(base)}</p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">Total to repay</p>
          <p className="text-xs font-semibold tabular-nums">{formatUGX(total)}</p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">Daily</p>
          <p className="text-xs font-semibold tabular-nums">
            {formatUGX(s.firstDaily)} → {formatUGX(s.lastDaily)}
          </p>
        </div>
      </div>

      <div className="rounded-md border divide-y">
        {s.rows.map((r) => (
          <div key={r.monthIndex} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1.5">
            <span className="text-[11px] font-medium">Month {r.monthIndex}</span>
            <span className="text-[11px] text-muted-foreground">
              {day(r.periodStart)} – {day(r.periodEnd)} · {r.daysInPeriod} days
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {formatUGX(r.principalDue)} + {formatUGX(r.chargeDue)} charge
            </span>
            <span className="text-[11px] font-semibold tabular-nums">
              {formatUGX(r.totalDue)} · {formatUGX(r.dailyDeduction)}/day
            </span>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground">
        The charge each month is {SMARTPHONE_MONTHLY_CHARGE_PCT}% of what is still owed, so the daily
        deduction falls as the balance comes down.
      </p>
    </div>
  );
}

export default SmartphoneRepaymentBreakdown;
