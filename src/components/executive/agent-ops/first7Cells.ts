import { format, parseISO } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { DAY_STATE_LABEL, addDays, type DayState, type First7Row, type RowStatus } from '@/lib/newTenantFirst7';

// How a day, a status and a Rent Plan look in the First 7 Days grid, the phone cards and the side panel. Semantic tokens only.

export const fmtDay = (iso: string) => format(parseISO(iso), 'd MMM');

export type CellKind = DayState;

/** What a day cell shows. The state comes from the server; a day with nothing due is "not due" (weekly days 2 to 7). */
export function cellKind(r: First7Row, i: number): CellKind {
  const state = r.day_state[i] ?? 'future';
  const paid = r.day_paid[i] ?? 0;
  if (paid > 0 && (state === 'paid' || state === 'part')) return state;
  if ((r.day_due[i] ?? 0) === 0) return 'not_due';
  return state;
}

export const CELL_TONE: Record<CellKind, string> = {
  paid: 'bg-success/15 text-success',
  part: 'bg-warning/15 text-warning',
  missed: 'bg-destructive/15 text-destructive',
  future: 'bg-muted/40 text-muted-foreground',
  not_due: 'border border-dashed border-border bg-transparent text-muted-foreground',
};
export const DOT_TONE: Record<CellKind, string> = {
  paid: 'bg-success',
  part: 'bg-warning',
  missed: 'bg-destructive',
  future: 'bg-muted',
  not_due: 'border border-dashed border-muted-foreground/60 bg-transparent',
};
export const STATUS_TONE: Record<RowStatus, string> = {
  on_track: 'border-success/20 bg-success/10 text-success',
  behind: 'border-destructive/20 bg-destructive/10 text-destructive',
  not_started: 'border-warning/20 bg-warning/10 text-warning',
  too_early: 'border-border bg-muted/50 text-muted-foreground',
};

export function cellText(r: First7Row, i: number, kind: CellKind): string {
  const paid = r.day_paid[i] ?? 0;
  const due = r.day_due[i] ?? 0;
  if (kind === 'not_due') return 'not due';
  if (kind === 'future') return r.frequency === 'weekly' && due > 0 ? `due ${formatUGX(due)}` : '—';
  if (kind === 'missed') return 'Missed';
  return formatUGX(paid);
}

export function cellTitle(r: First7Row, i: number, kind: CellKind): string {
  const paid = r.day_paid[i] ?? 0;
  const due = r.day_due[i] ?? 0;
  return [`Day ${i + 1} · ${fmtDay(addDays(r.day1, i))} · ${DAY_STATE_LABEL[kind]}`, due > 0 ? `due ${formatUGX(due)}` : null, paid > 0 ? `paid ${formatUGX(paid)}` : null]
    .filter(Boolean)
    .join(' · ');
}

export const isDueDay = (r: First7Row, i: number) => r.frequency === 'weekly' && (r.day_due[i] ?? 0) > 0;



export const planLabel = (r: First7Row) =>
  r.frequency === 'weekly' ? `Weekly · ${formatUGX(r.day_due.find((d) => d > 0) ?? r.daily_due * 7)} / week` : `Daily · ${formatUGX(r.daily_due)} / day`;
