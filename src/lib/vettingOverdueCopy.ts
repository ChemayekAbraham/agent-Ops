export type OverdueKind = 'rent_plan' | 'landlord' | 'lc1';

export interface OverdueVetting {
  enabled: boolean;
  overdue_hours: number;
  warn_hours: number;
  /** Items created before this are aged from it, so the backlog clock restarts at go-live. */
  effective_from?: string | null;
  remind_after_seconds: number;
  overdue_count: number;
  due_soon_count: number;
  escalated_count: number;
  oldest_age_hours: number;
  by_kind: Record<OverdueKind, number>;
  oldest: { kind: OverdueKind; id: string; label: string | null; age_hours: number }[];
}

export type OverdueTone = 'overdue' | 'escalated';

export interface OverdueDialogCopy {
  tone: OverdueTone;
  title: string;
  body: string;
  primaryLabel: string;
  secondaryLabel: string;
}

const KIND_SINGULAR: Record<OverdueKind, string> = { rent_plan: 'Rent Plan', landlord: 'Landlord', lc1: 'LC1 chairperson' };

/** 100h -> "4d 4h", 30h -> "1d 6h", 5h -> "5h". */
export function formatAge(hours: number): string {
  const h = Math.max(0, Math.floor(hours));
  const d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : `${h}h`;
}

/** Wording for the dialog. No emojis; "Rent Plan" never "loan". Pure so it can be tested and reused. */
export function buildOverdueDialogCopy(v: OverdueVetting): OverdueDialogCopy {
  const escalated = v.escalated_count > 0;
  const age = formatAge(v.oldest_age_hours);

  if (escalated) {
    return {
      tone: 'escalated',
      title: 'Escalated to Agent Ops',
      body:
        `${v.escalated_count} ${v.escalated_count === 1 ? 'item is' : 'items are'} now more than ${Math.round(v.overdue_hours * 1.5)} hours old. ` +
        `Agent Ops can see this. You have ${v.overdue_count} overdue in total. Please clear them today.`,
      primaryLabel: 'Review oldest now',
      secondaryLabel: 'Remind me in 1 minute',
    };
  }

  if (v.overdue_count === 1) {
    const only = v.oldest[0];
    const what = only ? KIND_SINGULAR[only.kind] : 'item';
    const who = only?.label ? ` for ${only.label}` : '';
    return {
      tone: 'overdue',
      title: 'Vetting overdue',
      body: `One ${what}${who} has been waiting ${age} for your review. Please approve, reject or return it to the agent.`,
      primaryLabel: 'Review now',
      secondaryLabel: 'Remind me in 1 minute',
    };
  }

  const parts: string[] = [];
  if (v.by_kind.rent_plan) parts.push(`${v.by_kind.rent_plan} Rent Plan${v.by_kind.rent_plan === 1 ? '' : 's'}`);
  if (v.by_kind.landlord) parts.push(`${v.by_kind.landlord} Landlord${v.by_kind.landlord === 1 ? '' : 's'}`);
  if (v.by_kind.lc1) parts.push(`${v.by_kind.lc1} LC1 chairperson${v.by_kind.lc1 === 1 ? '' : 's'}`);
  return {
    tone: 'overdue',
    title: 'Vetting overdue',
    body:
      `You have ${v.overdue_count} items waiting more than ${v.overdue_hours} hours for your review: ${parts.join(', ')}. ` +
      `The oldest has been waiting ${age}. Tenants and agents are held up until you decide.`,
    primaryLabel: 'Review oldest now',
    secondaryLabel: 'Remind me in 1 minute',
  };
}

/** Text for the quiet banner shown before anything is overdue (no dialog). Null when there is nothing to say. */
export function buildDueSoonBanner(v: OverdueVetting): string | null {
  if (v.due_soon_count <= 0) return null;
  const left = Math.max(1, v.overdue_hours - v.warn_hours);
  return `${v.due_soon_count} ${v.due_soon_count === 1 ? 'item' : 'items'} will pass the ${v.overdue_hours}-hour limit within ${left} hours.`;
}

/** The moment an item's waiting clock starts: the later of its creation and the policy's go-live. Mirrors the server so chips and the dialog agree. */
export function vettingClockAt(createdAt?: string | null, effectiveFrom?: string | null): string | null {
  if (!createdAt) return null;
  if (!effectiveFrom) return createdAt;
  const c = new Date(createdAt).getTime();
  const e = new Date(effectiveFrom).getTime();
  if (!Number.isFinite(c)) return null;
  if (!Number.isFinite(e)) return createdAt;
  return new Date(Math.max(c, e)).toISOString();
}
