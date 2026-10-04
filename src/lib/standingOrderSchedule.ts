import type { PayoutScheduleConfig } from '@/components/cfo/PayoutAutomationToggle';

// Recurrence shape shared by the UI config and the DB row.
export interface RecurrenceConfig {
  frequency: 'daily' | 'weekly' | 'interval' | 'monthly' | string;
  day_of_week?: number | null;
  interval_days?: number | null;
}

/**
 * Compute the first next_run_at for a brand-new standing order.
 * Daily / weekly / interval keep the creation time-of-day implicitly (they add
 * whole days to `from`). Monthly must explicitly carry the creation time-of-day
 * so the order keeps paying out at the same moment each month.
 */
export function getNextRunDate(config: PayoutScheduleConfig, from: Date = new Date()): string {
  const now = new Date(from);
  switch (config.frequency) {
    case 'daily': {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      return next.toISOString();
    }
    case 'weekly': {
      const next = new Date(now);
      const target = ((config.dayOfWeek % 7) + 7) % 7;
      let diff = (target - next.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      next.setDate(next.getDate() + diff);
      return next.toISOString();
    }
    case 'interval': {
      const next = new Date(now);
      next.setDate(next.getDate() + Math.max(1, config.intervalDays));
      return next.toISOString();
    }
    case 'monthly':
    default: {
      // Preserve the exact time-of-day the standing order was created.
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        config.dayOfMonth,
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
        now.getMilliseconds(),
      );
      if (next <= now) next.setMonth(next.getMonth() + 1);
      return next.toISOString();
    }
  }
}

/**
 * Advance next_run_at for an already-running standing order, starting from its
 * previous next_run_at. Using setMonth/setDate on the prior timestamp inherently
 * preserves the original time-of-day across every cycle.
 * Mirrors the logic in supabase/functions/process-scheduled-payouts.
 */
export function computeNextRun(from: Date, config: RecurrenceConfig): Date {
  const next = new Date(from);
  switch (config.frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      return next;
    case 'weekly': {
      const target = ((Number(config.day_of_week ?? 1) % 7) + 7) % 7;
      let diff = (target - next.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      next.setDate(next.getDate() + diff);
      return next;
    }
    case 'interval':
      next.setDate(next.getDate() + Math.max(1, Number(config.interval_days ?? 1)));
      return next;
    case 'monthly':
    default:
      next.setMonth(next.getMonth() + 1);
      return next;
  }
}
