/**
 * Repayment cycle + duration label for rent plan cards (pipeline queues).
 * Presentation only — never used for any eligibility or money calculation.
 */
export type RentCycleTone = 'daily' | 'weekly' | 'monthly' | 'unknown';

export interface RentCycleLabel {
  cycle: string;
  duration: string;
  full: string;
  tone: RentCycleTone;
}

export function getRentCycleLabel(
  frequency: string | null | undefined,
  durationDays: number | null | undefined,
): RentCycleLabel {
  const raw = (frequency || '').trim().toLowerCase();
  const tone: RentCycleTone =
    raw === 'daily' || raw === 'weekly' || raw === 'monthly' ? raw : 'unknown';

  const cycle =
    tone === 'daily' ? 'Daily'
    : tone === 'weekly' ? 'Weekly'
    : tone === 'monthly' ? 'Monthly'
    : raw ? raw.charAt(0).toUpperCase() + raw.slice(1)
    : 'Cycle not set';

  const days = typeof durationDays === 'number' && durationDays > 0 ? durationDays : null;
  let duration = '';
  if (days) {
    if (tone === 'weekly') {
      // Weekly plans store the number of weekly instalments in this field for
      // short terms (e.g. 7 = seven weekly payments), and calendar days for
      // longer ones (e.g. 84 = twelve weeks). Read both correctly.
      const weeks = days <= 12 ? days : Math.round(days / 7);
      duration = weeks > 0 ? `${weeks} ${weeks === 1 ? 'week' : 'weeks'}` : `${days} days`;
    } else if (tone === 'monthly') {
      const months = Math.round(days / 30);
      duration = months > 0 ? `${months} ${months === 1 ? 'month' : 'months'}` : `${days} days`;
    } else {
      duration = `${days} days`;
    }
  }

  return {
    cycle,
    duration,
    full: duration ? `${cycle} · ${duration}` : cycle,
    tone,
  };
}

export const RENT_CYCLE_BADGE_CLASSES: Record<RentCycleTone, string> = {
  daily: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  weekly: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
  monthly: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};
