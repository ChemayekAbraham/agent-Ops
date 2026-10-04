import type { AgentCapacity } from '@/hooks/useAgentCapacityMap';
import { DAILY_ELIGIBILITY_THRESHOLD } from '@/hooks/useAgentCapacityMap';

export type BadgeTone = 'gold' | 'green' | 'blue' | 'amber';

export interface AgentBadge {
  id: string;
  /** Short emblem rendered before the label (emoji keeps PNG export simple). */
  icon: string;
  label: string;
  tone: BadgeTone;
}

/** Solid hex pairs for the off-screen PNG share card (no CSS vars there). */
export const BADGE_HEX: Record<BadgeTone, { bg: string; fg: string }> = {
  gold:  { bg: 'rgba(234,179,8,0.18)',  fg: '#fde68a' },
  green: { bg: 'rgba(16,185,129,0.18)', fg: '#6ee7b7' },
  blue:  { bg: 'rgba(59,130,246,0.18)', fg: '#93c5fd' },
  amber: { bg: 'rgba(245,158,11,0.18)', fg: '#fcd34d' },
};

/** Badge palette for the light (white-background) share card. */
export const BADGE_HEX_LIGHT: Record<BadgeTone, { bg: string; fg: string }> = {
  gold:  { bg: '#fef3c7', fg: '#92400e' },
  green: { bg: '#d1fae5', fg: '#047857' },
  blue:  { bg: '#dbeafe', fg: '#1d4ed8' },
  amber: { bg: '#fef3c7', fg: '#b45309' },
};

/** Tailwind classes for the in-app (themed) badge chips. */
export const BADGE_CLASS: Record<BadgeTone, string> = {
  gold:  'bg-amber-400/15 text-amber-600 dark:text-amber-300',
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  blue:  'bg-blue-500/15 text-blue-600 dark:text-blue-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

/**
 * Derives the agent's earned honour badges purely from their live capacity
 * snapshot — no extra queries. Badges esteem the two behaviours we reward
 * most: building a big book of tenants (houses) and collecting every day.
 * Returns badges ordered by prestige; callers usually show the top few.
 */
export function deriveAgentBadges(cap: AgentCapacity): AgentBadge[] {
  const badges: AgentBadge[] = [];
  const tenants = cap.active_tenant_count || 0;
  const todayPct = cap.expected_daily > 0 ? cap.paid_today / cap.expected_daily : 0;
  const collectedToday = cap.paid_today > 0 && todayPct >= DAILY_ELIGIBILITY_THRESHOLD;

  // --- Esteem: biggest book of tenants/houses ---
  if (tenants >= 30) {
    badges.push({ id: 'top-lister', icon: '👑', label: 'Top Lister', tone: 'gold' });
  } else if (tenants >= 15) {
    badges.push({ id: 'big-book', icon: '🏆', label: 'Big Book', tone: 'gold' });
  } else if (tenants >= 5) {
    badges.push({ id: 'growing-book', icon: '📈', label: 'Growing Book', tone: 'blue' });
  }

  // --- Esteem: collects daily ---
  if (todayPct >= 1) {
    badges.push({ id: 'target-smashed', icon: '🎯', label: 'Target Smashed', tone: 'green' });
  } else if (collectedToday) {
    badges.push({ id: 'daily-collector', icon: '🔥', label: 'Daily Collector', tone: 'green' });
  }

  // --- Consistency / tier prestige ---
  if (cap.response_rate >= 0.7) {
    badges.push({ id: 'consistent', icon: '💪', label: 'Consistent', tone: 'green' });
  }
  if (cap.tier === 'Positive') {
    badges.push({ id: 'elite-agent', icon: '⭐', label: 'Elite Agent', tone: 'gold' });
  }
  if (cap.is_new_agent) {
    badges.push({ id: 'rising-star', icon: '🌱', label: 'Rising Star', tone: 'amber' });
  }

  if (badges.length === 0) {
    badges.push({ id: 'on-the-board', icon: '✨', label: 'On the Board', tone: 'blue' });
  }

  return badges;
}