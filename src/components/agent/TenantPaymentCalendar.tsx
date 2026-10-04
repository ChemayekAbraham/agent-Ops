import { useMemo, useState } from 'react';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek, addMonths, isSameMonth, isSameDay,
  isAfter, isBefore, startOfDay, addDays,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Flame, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';

export interface CalendarRepayment {
  amount: number;
  created_at: string;
  rent_request_id?: string | null;
}

export interface CalendarRentPlan {
  id: string;
  /** ISO date the plan started (disbursed_at or created_at fallback). */
  startDate: string;
  /** Plan duration in days. */
  durationDays: number;
  /** Daily expected payment in UGX. */
  dailyExpected: number;
}

interface Props {
  plan: CalendarRentPlan | null;
  repayments: CalendarRepayment[];
}

type DayStatus = 'paid' | 'partial' | 'missed' | 'upcoming' | 'outside';

const STATUS_STYLES: Record<DayStatus, string> = {
  paid: 'bg-success/85 text-success-foreground border-success',
  partial: 'bg-warning/80 text-warning-foreground border-warning',
  missed: 'bg-destructive/80 text-destructive-foreground border-destructive',
  upcoming: 'bg-muted/40 text-muted-foreground border-border/60',
  outside: 'bg-transparent text-muted-foreground/40 border-transparent',
};

export function TenantPaymentCalendar({ plan, repayments }: Props) {
  const today = startOfDay(new Date());

  const planStart = plan ? startOfDay(new Date(plan.startDate)) : null;
  const planEnd = plan && planStart ? addDays(planStart, Math.max(1, plan.durationDays) - 1) : null;

  // Default month: today clamped to plan window
  const defaultMonth = useMemo(() => {
    if (!planStart || !planEnd) return today;
    if (isBefore(today, planStart)) return planStart;
    if (isAfter(today, planEnd)) return planEnd;
    return today;
  }, [planStart?.getTime(), planEnd?.getTime()]);

  const [viewMonth, setViewMonth] = useState<Date>(defaultMonth);

  // Bucket repayments by yyyy-MM-dd (local), only for this plan
  const dayTotals = useMemo(() => {
    const map = new Map<string, number>();
    if (!plan) return map;
    for (const r of repayments) {
      if (r.rent_request_id && r.rent_request_id !== plan.id) continue;
      const key = format(new Date(r.created_at), 'yyyy-MM-dd');
      map.set(key, (map.get(key) || 0) + Number(r.amount || 0));
    }
    return map;
  }, [repayments, plan?.id]);

  const classify = (day: Date): DayStatus => {
    if (!plan || !planStart || !planEnd) return 'outside';
    if (isBefore(day, planStart) || isAfter(day, planEnd)) return 'outside';
    const key = format(day, 'yyyy-MM-dd');
    const got = dayTotals.get(key) || 0;
    if (isAfter(day, today)) return got > 0 ? 'paid' : 'upcoming';
    if (got >= plan.dailyExpected && plan.dailyExpected > 0) return 'paid';
    if (got > 0) return 'partial';
    return 'missed';
  };

  // Build streaks over the full plan window (not just visible month)
  const { currentStreak, bestStreak, paidDays, totalElapsed, collectedToDate, expectedToDate } = useMemo(() => {
    if (!plan || !planStart || !planEnd) {
      return { currentStreak: 0, bestStreak: 0, paidDays: 0, totalElapsed: 0, collectedToDate: 0, expectedToDate: 0 };
    }
    const lastDay = isBefore(today, planEnd) ? today : planEnd;
    if (isBefore(lastDay, planStart)) {
      return { currentStreak: 0, bestStreak: 0, paidDays: 0, totalElapsed: 0, collectedToDate: 0, expectedToDate: 0 };
    }
    const days = eachDayOfInterval({ start: planStart, end: lastDay });
    let cur = 0, best = 0, paid = 0, collected = 0;
    for (const d of days) {
      const got = dayTotals.get(format(d, 'yyyy-MM-dd')) || 0;
      collected += got;
      const isPaid = plan.dailyExpected > 0 && got >= plan.dailyExpected;
      if (isPaid) {
        paid += 1;
        cur += 1;
        if (cur > best) best = cur;
      } else {
        cur = 0;
      }
    }
    // current streak = ending at last elapsed day
    let trailing = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const got = dayTotals.get(format(days[i], 'yyyy-MM-dd')) || 0;
      if (plan.dailyExpected > 0 && got >= plan.dailyExpected) trailing += 1;
      else break;
    }
    return {
      currentStreak: trailing,
      bestStreak: best,
      paidDays: paid,
      totalElapsed: days.length,
      collectedToDate: collected,
      expectedToDate: days.length * plan.dailyExpected,
    };
  }, [plan?.id, planStart?.getTime(), planEnd?.getTime(), dayTotals, today.getTime()]);

  if (!plan || !planStart || !planEnd) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        No active rent plan to chart yet.
      </p>
    );
  }

  // Build calendar grid (Monday-start) for viewMonth
  const gridStart = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 1 });
  const gridDays = eachDayOfInterval({ start: gridStart, end: gridEnd });

  const canGoPrev = isAfter(startOfMonth(viewMonth), startOfMonth(planStart));
  const canGoNext = isBefore(startOfMonth(viewMonth), startOfMonth(planEnd));

  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="space-y-3">
      {/* Header chips */}
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline" className="gap-1 text-xs">
          <Flame className="h-3 w-3 text-warning" />
          Streak: <span className="font-mono font-bold">{currentStreak}d</span>
        </Badge>
        <Badge variant="outline" className="text-xs">
          Best: <span className="font-mono font-bold ml-1">{bestStreak}d</span>
        </Badge>
        <Badge variant="outline" className="text-xs">
          Paid <span className="font-mono font-bold mx-1">{paidDays}</span>/ {totalElapsed}d
        </Badge>
        <Badge variant="outline" className="text-xs">
          <span className="font-mono">{formatUGX(collectedToDate)}</span>
          <span className="text-muted-foreground ml-1">/ {formatUGX(expectedToDate)}</span>
        </Badge>
      </div>

      {/* Month nav */}
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => setViewMonth(m => addMonths(m, -1))}
          disabled={!canGoPrev}
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          {format(viewMonth, 'MMMM yyyy')}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => setViewMonth(m => addMonths(m, 1))}
          disabled={!canGoNext}
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 text-center">
        {weekdayLabels.map(w => (
          <div key={w} className="text-[10px] font-medium text-muted-foreground uppercase">{w}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {gridDays.map(day => {
          const status = classify(day);
          const inMonth = isSameMonth(day, viewMonth);
          const isToday = isSameDay(day, today);
          const key = format(day, 'yyyy-MM-dd');
          const got = dayTotals.get(key) || 0;
          const title =
            status === 'outside'
              ? `${format(day, 'PP')} — outside plan`
              : `${format(day, 'PP')} · Collected ${formatUGX(got)} / Expected ${formatUGX(plan.dailyExpected)}`;
          return (
            <div
              key={key}
              title={title}
              className={cn(
                'aspect-square rounded-md border flex items-center justify-center text-[11px] font-medium transition-colors',
                STATUS_STYLES[status],
                !inMonth && 'opacity-40',
                isToday && status !== 'outside' && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
              )}
            >
              {format(day, 'd')}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-success/85 border border-success" /> Paid</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-warning/80 border border-warning" /> Partial</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-destructive/80 border border-destructive" /> Missed</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-muted/40 border border-border/60" /> Upcoming</span>
      </div>
    </div>
  );
}
