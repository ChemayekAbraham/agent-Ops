import { formatDynamic } from '@/lib/currencyFormat';
import {
  canShowNudgeWith,
  isNudgeEligible,
  kampalaHour,
  ordinal,
  pickTemplate,
  placeholdersOf,
  recordNudgeWith,
  renderNudge as renderWith,
  tidyName,
  type NudgeHistory,
  type NudgePacing,
  type NudgeRule,
  type NudgeTemplate as Template,
  type NudgeTone,
  type NudgeValue,
  type RenderedNudge as Rendered,
} from '@/lib/nudges/engine';
import nudgeFile from './nudges.json';

/**
 * Agent dashboard nudges: catchy, personal toasts ("Hi 👋 Boss, you're missing
 * out on UGX 12,000 in commission 😎").
 *
 * The copy lives in `nudges.json`; this module only decides which nudge fits
 * the agent's numbers right now and fills in its placeholders. It does not
 * fetch anything and does not show the toast: the caller supplies
 * `AgentNudgeStats` (one server call) and renders the result.
 *
 * Definitions the stats must follow:
 * - "Today" is the Kampala calendar day.
 * - Due/uncollected come from today's pinned bill (`agent_expected_day_plans`)
 *   matched per tenant against `agent_collections`, never by dividing totals.
 * - An active agent today is one with an `agent_collections` row today. Rank is
 *   among those agents, by amount collected today (1 = most).
 * - Commission figures use the agent's own rate per tenant, not a flat 10%.
 */

/** Numbers for one agent, as returned by the stats RPC. null = unknown / not applicable. */
export interface AgentNudgeStats {
  first_name: string | null;

  /** Tenants on today's pinned bill, and the amount they owe today. */
  due_today_count: number;
  expected_today: number;
  /** Tenants on today's bill with a collection today, and the amount collected. */
  collected_today_count: number;
  collected_today: number;
  /** Tenants on today's bill with no collection yet, and what they still owe. */
  uncollected_count: number;
  uncollected_amount: number;
  /** Commission the agent would earn on the uncollected amount, at their own rates. */
  missed_commission: number;
  earned_commission_today: number;
  /** The uncollected tenant owing the most today; null when nothing is uncollected. */
  top_tenant_name: string | null;
  top_tenant_amount: number | null;

  /** Agents with an agent_collections row today. */
  active_agents_today: number;
  /** This agent's rank today; null when they haven't collected today. */
  rank_today: number | null;
  rank_yesterday: number | null;
  /** Amount more needed today to pass the agent ranked just above; null at #1 or unranked. */
  gap_to_next_rank: number | null;

  /** Consecutive days with a collection, ending today if collected today, else yesterday. */
  streak_days: number;

  /** Tenants the agent manages, added in the last 7 days, and days since the last one. */
  tenants_total: number;
  new_tenants_7d: number;
  days_since_new_tenant: number | null;
}

export type { NudgeHistory, NudgeRule, NudgeTone };
export { isNudgeEligible, kampalaHour, ordinal, placeholdersOf, tidyName };

export type NudgeCta = 'collect' | 'add_tenant' | 'leaderboard';
export type NudgeTemplate = Template<NudgeCta>;
export type RenderedNudge = Rendered<NudgeCta>;

export const NUDGES: NudgeTemplate[] = (nudgeFile as { nudges: NudgeTemplate[] }).nudges;

/** Stats fields that are amounts in UGX and render with the viewer's currency. */
const MONEY_KEYS = new Set([
  'expected_today',
  'collected_today',
  'uncollected_amount',
  'missed_commission',
  'earned_commission_today',
  'top_tenant_amount',
  'gap_to_next_rank',
]);

type Value = NudgeValue;

export function rankEmoji(rank: number, total: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  if (rank <= 10) return '🔥';
  const pct = (rank / Math.max(total, 1)) * 100;
  if (pct <= 25) return '🚀';
  if (pct <= 50) return '💪';
  return '📈';
}

/** Raw values every rule and placeholder can reference: the stats plus derived fields. */
export function buildNudgeValues(stats: AgentNudgeStats, now: Date = new Date()): Record<string, Value> {
  const rank = stats.rank_today;
  const active = stats.active_agents_today;
  const ranked = rank != null && rank >= 1 && active >= 1;
  const prev = stats.rank_yesterday;

  return {
    ...stats,
    first_name: tidyName(stats.first_name?.trim().split(/\s+/)[0]),
    top_tenant_name: tidyName(stats.top_tenant_name),
    hour: kampalaHour(now),
    coverage_pct: stats.due_today_count > 0
      ? Math.floor((stats.collected_today_count / stats.due_today_count) * 100)
      : null,
    rank_ordinal: ranked ? ordinal(rank) : null,
    rank_emoji: ranked ? rankEmoji(rank, active) : null,
    next_rank_ordinal: ranked && rank > 1 ? ordinal(rank - 1) : null,
    agents_ahead: ranked ? rank - 1 : null,
    top_percent: ranked ? Math.max(1, Math.ceil((rank / active) * 100)) : null,
    rank_yesterday_ordinal: prev != null && prev >= 1 ? ordinal(prev) : null,
    rank_climb: ranked && prev != null && prev >= 1 ? prev - rank : null,
    gap_to_next_rank: ranked && rank > 1 ? stats.gap_to_next_rank : null,
  };
}

/** Every key a nudge may use in `when` or a {placeholder}. */
export const NUDGE_VALUE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(buildNudgeValues({
    first_name: null, due_today_count: 0, expected_today: 0, collected_today_count: 0,
    collected_today: 0, uncollected_count: 0, uncollected_amount: 0, missed_commission: 0,
    earned_commission_today: 0, top_tenant_name: null, top_tenant_amount: null,
    active_agents_today: 0, rank_today: null, rank_yesterday: null, gap_to_next_rank: null,
    streak_days: 0, tenants_total: 0, new_tenants_7d: 0, days_since_new_tenant: null,
  })),
);

export function renderNudge(
  t: NudgeTemplate,
  values: Record<string, Value>,
  formatMoney: (amount: number) => string = formatDynamic,
): RenderedNudge {
  return renderWith(t, values, { moneyKeys: MONEY_KEYS, formatMoney });
}

/** How often nudges may appear: at most one per COOLDOWN, only in waking hours. */
export const NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
export const NUDGE_HOURS = { from: 6, to: 21 } as const; // Kampala, [from, to)
export const NUDGE_RECENT_LIMIT = 6;

const PACING: NudgePacing = { cooldownMs: NUDGE_COOLDOWN_MS, hours: NUDGE_HOURS, recentLimit: NUDGE_RECENT_LIMIT };

export function canShowNudge(history: NudgeHistory, now: Date = new Date()): boolean {
  return canShowNudgeWith(PACING, history, now);
}

export function recordNudge(history: NudgeHistory, id: string, now: Date = new Date()): NudgeHistory {
  return recordNudgeWith(PACING, history, id, now);
}

export interface PickOptions {
  now?: Date;
  /** Nudge ids to skip, e.g. the last few shown. Ignored if it would leave nothing. */
  exclude?: Iterable<string>;
  /** Returns a number in [0, 1). Defaults to Math.random. */
  random?: () => number;
  formatMoney?: (amount: number) => string;
  templates?: NudgeTemplate[];
}

/** Weighted-random pick among the nudges that fit right now; null when none fit. */
export function pickNudge(stats: AgentNudgeStats, opts: PickOptions = {}): RenderedNudge | null {
  const values = buildNudgeValues(stats, opts.now);
  const chosen = pickTemplate(opts.templates ?? NUDGES, values, opts);
  return chosen ? renderNudge(chosen, values, opts.formatMoney) : null;
}
