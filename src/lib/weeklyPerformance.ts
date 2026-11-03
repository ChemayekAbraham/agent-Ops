/**
 * Agent Weekly Performance — shapes and the small amount of arithmetic the page
 * shows. Every figure comes from `get_my_weekly_performance` (migration
 * 20261023140000); this file only turns "required % × due" into amounts.
 *
 * The rule (20261023130000): agents are judged on the last completed
 * Thursday–Wednesday week. Current Rent Plans need 50% of what they were due;
 * agents with expired plans also need 20% on those; agents whose plans have
 * all expired need 70%. Collections are capped per plan at its due.
 */

export type WeeklyBook = 'none' | 'in_window_only' | 'mixed' | 'all_expired';

export type PerformanceWeek = {
  week_start: string;
  week_end: string;
  is_judged: boolean;
  book: WeeklyBook;
  in_window_due: number;
  in_window_collected: number;
  in_window_plans: number;
  in_window_pct: number | null;
  in_window_required_pct: number | null;
  expired_due: number;
  expired_collected: number;
  expired_plans: number;
  expired_pct: number | null;
  expired_required_pct: number | null;
  passes: boolean;
  reason: string | null;
};

export type CurrentWeek = {
  week_start: string;
  week_end: string;
  today: string;
  days_elapsed: number;
  days_left: number;
  book: WeeklyBook;
  in_window_due_so_far: number;
  in_window_collected: number;
  in_window_plans: number;
  in_window_projected_due: number;
  expired_due_so_far: number;
  expired_collected: number;
  expired_plans: number;
  expired_projected_due: number;
  in_window_required_pct: number | null;
  expired_required_pct: number | null;
};

export type PerformancePlan = {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  expired: boolean;
  due_so_far: number;
  collected: number;
  paid_raw: number;
  daily_due: number;
};

export type WeeklyPerformance = {
  agent_id: string;
  settings: {
    in_window_required_pct: number;
    expired_required_pct: number;
    all_expired_required_pct: number;
    enforced: boolean;
  };
  current_week: CurrentWeek;
  weeks: PerformanceWeek[];
  plans: PerformancePlan[];
};

const n = (v: unknown) => Number(v) || 0;
const pctOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Normalises the RPC's jsonb (numerics arrive as strings or numbers). */
export function parseWeeklyPerformance(raw: any): WeeklyPerformance {
  const cw = raw?.current_week ?? {};
  return {
    agent_id: raw?.agent_id ?? '',
    settings: {
      in_window_required_pct: n(raw?.settings?.in_window_required_pct),
      expired_required_pct: n(raw?.settings?.expired_required_pct),
      all_expired_required_pct: n(raw?.settings?.all_expired_required_pct),
      enforced: raw?.settings?.enforced === true,
    },
    current_week: {
      week_start: cw.week_start,
      week_end: cw.week_end,
      today: cw.today,
      days_elapsed: n(cw.days_elapsed),
      days_left: n(cw.days_left),
      book: (cw.book ?? 'none') as WeeklyBook,
      in_window_due_so_far: n(cw.in_window_due_so_far),
      in_window_collected: n(cw.in_window_collected),
      in_window_plans: n(cw.in_window_plans),
      in_window_projected_due: n(cw.in_window_projected_due),
      expired_due_so_far: n(cw.expired_due_so_far),
      expired_collected: n(cw.expired_collected),
      expired_plans: n(cw.expired_plans),
      expired_projected_due: n(cw.expired_projected_due),
      in_window_required_pct: pctOrNull(cw.in_window_required_pct),
      expired_required_pct: pctOrNull(cw.expired_required_pct),
    },
    weeks: ((raw?.weeks as any[]) ?? []).map((w) => ({
      week_start: w.week_start,
      week_end: w.week_end,
      is_judged: w.is_judged === true,
      book: (w.book ?? 'none') as WeeklyBook,
      in_window_due: n(w.in_window_due),
      in_window_collected: n(w.in_window_collected),
      in_window_plans: n(w.in_window_plans),
      in_window_pct: pctOrNull(w.in_window_pct),
      in_window_required_pct: pctOrNull(w.in_window_required_pct),
      expired_due: n(w.expired_due),
      expired_collected: n(w.expired_collected),
      expired_plans: n(w.expired_plans),
      expired_pct: pctOrNull(w.expired_pct),
      expired_required_pct: pctOrNull(w.expired_required_pct),
      passes: w.passes !== false,
      reason: w.reason ?? null,
    })),
    plans: ((raw?.plans as any[]) ?? []).map((p) => ({
      rent_request_id: p.rent_request_id,
      tenant_id: p.tenant_id ?? null,
      tenant_name: p.tenant_name ?? 'Tenant',
      tenant_phone: p.tenant_phone ?? null,
      expired: p.expired === true,
      due_so_far: n(p.due_so_far),
      collected: n(p.collected),
      paid_raw: n(p.paid_raw),
      daily_due: n(p.daily_due),
    })),
  };
}

/** One group's standing against its target. `required` null = the group isn't tested. */
export type GroupProgress = {
  due: number;
  collected: number;
  required: number | null;
  /** Amount that meets the target (required × due), rounded up to the shilling. */
  target: number;
  /** Still to collect to reach the target; 0 once met. */
  remaining: number;
  /** collected ÷ due, 0..1 (0 when nothing is due). */
  ratio: number;
  met: boolean;
};

export function groupProgress(due: number, collected: number, required: number | null): GroupProgress {
  const target = required === null ? 0 : Math.ceil(required * due);
  const remaining = Math.max(0, target - collected);
  return {
    due,
    collected,
    required,
    target,
    remaining,
    ratio: due > 0 ? Math.min(1, collected / due) : 0,
    // Same comparison as the server: on amounts, not rounded percentages.
    met: required === null || collected >= required * due,
  };
}

/**
 * This week measured against the projected FULL week's due — the amount the
 * agent will be judged on next Thursday if every billed plan keeps being billed.
 */
export function currentWeekProgress(cw: CurrentWeek) {
  const current = groupProgress(cw.in_window_projected_due, cw.in_window_collected, cw.in_window_required_pct);
  const expired = groupProgress(cw.expired_projected_due, cw.expired_collected, cw.expired_required_pct);
  return { current, expired, onTrack: current.met && expired.met };
}

/** The judged week's two groups, for the "why can / can't I post" card. */
export function judgedWeekProgress(w: PerformanceWeek) {
  return {
    current: groupProgress(w.in_window_due, w.in_window_collected, w.in_window_required_pct),
    expired: groupProgress(w.expired_due, w.expired_collected, w.expired_required_pct),
  };
}

/** "15 Oct" from an ISO date, without timezone drift. */
export function shortDay(iso: string | undefined | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/** The Thursday after the given week ends, when the next result is saved. */
export function nextResultDay(weekEndIso: string | undefined | null): string {
  if (!weekEndIso) return '';
  const [y, m, d] = weekEndIso.split('-').map(Number);
  const next = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + 1));
  return next.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
