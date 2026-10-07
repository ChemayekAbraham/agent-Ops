import { useState, useMemo } from 'react';
import { Calendar, ChevronLeft, ChevronRight, TrendingDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { spiroLeaseSchedule } from '@/lib/spiroBikeLease';

interface Props {
  termMonths: number;
  valuation: number;
  activatedAt?: string | null;
}

/**
 * Dropdown-driven repayment plan schedule for bike lease agents.
 * Allows viewing each month's reducing-balance repayment plan one month at a time,
 * from the first month to the final settlement month.
 */
export default function BikeRepaymentPlanSchedule({
  termMonths,
  valuation,
  activatedAt,
}: Props) {
  const term = Math.max(1, termMonths || 12);
  const schedule = useMemo(() => spiroLeaseSchedule(term, valuation), [term, valuation]);

  // Determine current active month based on lease activation date (if available)
  const activeMonth = useMemo(() => {
    if (!activatedAt) return 1;
    try {
      const act = new Date(activatedAt);
      const now = new Date();
      const diff = (now.getFullYear() - act.getFullYear()) * 12 + (now.getMonth() - act.getMonth()) + 1;
      return Math.min(term, Math.max(1, diff));
    } catch {
      return 1;
    }
  }, [activatedAt, term]);

  const [selectedMonth, setSelectedMonth] = useState<number>(activeMonth);

  const safeMonth = Math.min(term, Math.max(1, selectedMonth));
  const currentRow = schedule.rows[safeMonth - 1] ?? schedule.rows[0];

  if (!currentRow) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-3.5 space-y-3 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-primary shrink-0" />
          <p className="text-xs font-bold text-foreground whitespace-nowrap">Repayment Plan Schedule</p>
        </div>
        <Badge
          variant="outline"
          className="text-[10px] font-semibold bg-primary/10 text-primary border-primary/20 shrink-0"
        >
          {term} Months · 28%/mo reducing · {schedule.feePct}% total fee
        </Badge>
      </div>

      {/* Overall Lease Term Summary Strip */}
      <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-border/70 bg-muted/30 p-2 text-center text-xs">
        <div>
          <span className="text-[10px] text-muted-foreground block">Principal</span>
          <span className="font-bold text-foreground text-xs tabular-nums">
            {formatUGX(schedule.base)}
          </span>
        </div>
        <div>
          <span className="text-[10px] text-muted-foreground block">Total Fee ({schedule.feePct}%)</span>
          <span className="font-bold text-foreground text-xs tabular-nums">
            {formatUGX(schedule.accessFee)}
          </span>
        </div>
        <div>
          <span className="text-[10px] text-muted-foreground block">Total Payable</span>
          <span className="font-bold text-primary text-xs tabular-nums">
            {formatUGX(schedule.total)}
          </span>
        </div>
      </div>

      {/* Month Dropdown Selector (One month at a time) */}
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground font-medium flex items-center justify-between">
          <span>Select Month:</span>
          <span className="text-[10px] text-primary">
            Showing Month {safeMonth} of {term}
          </span>
        </label>
        <Select
          value={String(safeMonth)}
          onValueChange={(val) => setSelectedMonth(Number(val))}
        >
          <SelectTrigger className="h-9 text-xs font-medium w-full">
            <SelectValue placeholder="Choose month" />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            {schedule.rows.map((row) => (
              <SelectItem key={row.month} value={String(row.month)} className="text-xs">
                Month {row.month}
                {row.month === 1 ? ' (First)' : row.month === term ? ' (Final)' : ''}
                {row.month === activeMonth && ' · Current'} — {formatUGX(row.daily)}/d
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Selected Month Details */}
      <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wide text-primary">
              Month {safeMonth} Daily Repayment
            </span>
            <p className="text-base font-extrabold text-foreground tabular-nums">
              {formatUGX(currentRow.daily)}
              <span className="text-xs font-normal text-muted-foreground"> / day</span>
            </p>
          </div>
          <div className="text-right">
            <span className="text-[10px] text-muted-foreground block">
              {currentRow.days} calendar days
            </span>
          </div>
        </div>

        {/* Three cards: Due that month, Opening, Closing */}
        <div className="grid grid-cols-3 gap-1.5 sm:gap-2 pt-2 border-t border-primary/15">
          <div className="rounded-md border border-border/80 bg-background/80 p-2 text-center">
            <span className="text-[10px] text-muted-foreground block leading-tight">Due that month</span>
            <span className="font-bold text-foreground text-xs sm:text-sm tabular-nums block mt-0.5 whitespace-nowrap">
              {formatUGX(Math.round(currentRow.totalDue))}
            </span>
          </div>

          <div className="rounded-md border border-border/80 bg-background/80 p-2 text-center">
            <span className="text-[10px] text-muted-foreground block leading-tight">Opening</span>
            <span className="font-bold text-foreground text-xs sm:text-sm tabular-nums block mt-0.5 whitespace-nowrap">
              {formatUGX(Math.round(currentRow.openingPrincipal))}
            </span>
          </div>

          <div className="rounded-md border border-border/80 bg-background/80 p-2 text-center">
            <span className="text-[10px] text-muted-foreground block leading-tight">Closing</span>
            <span className="font-bold text-emerald-600 dark:text-emerald-400 text-xs sm:text-sm tabular-nums block mt-0.5 whitespace-nowrap">
              {formatUGX(Math.round(currentRow.closingPrincipal))}
            </span>
          </div>
        </div>

        {/* Prev / Next Month Navigation */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-primary/15">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
            disabled={safeMonth <= 1}
            onClick={() => setSelectedMonth((m) => Math.max(1, m - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev Month
          </Button>

          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <TrendingDown className="h-3 w-3 text-emerald-600" />
            28%/mo reducing balance
          </span>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
            disabled={safeMonth >= term}
            onClick={() => setSelectedMonth((m) => Math.min(term, m + 1))}
          >
            Next Month <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
