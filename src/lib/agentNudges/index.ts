import { formatDynamic } from '@/lib/currencyFormat';
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

export type NudgeTone = 'nudge' | 'celebrate' | 'info';
export type NudgeCta = 'collect' | 'add_tenant' | 'leaderboard';

export type NudgeRule = Partial<Record<'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne', number>> & {
  exists?: boolean;
};

export interface NudgeTemplate {
  id: string;
  category: string;
  tone: NudgeTone;
  weight?: number;
  when?: Record<string, NudgeRule>;
  title: string;
  body: string;
  cta?: NudgeCta;
}

export interface RenderedNudge {
  id: string;
  category: string;
  tone: NudgeTone;
  title: string;
  body: string;
  cta?: NudgeCta;
}

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

type Value = string | number | null;

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

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

export function kampalaHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Africa/Kampala' }).format(now),
  );
}

/** "SHAFEEQ" / "nakasagga juliet" → "Shafeeq" / "Nakasagga Juliet"; mixed case is kept. */
export function tidyName(name: string | null | undefined): string | null {
  const s = name?.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
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

const PLACEHOLDER = /\{(\w+)\}/g;

export function placeholdersOf(t: NudgeTemplate): string[] {
  return [...`${t.title} ${t.body}`.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

function ruleHolds(value: Value, rule: NudgeRule): boolean {
  const present = value != null && value !== '';
  if (rule.exists !== undefined && rule.exists !== present) return false;
  const numeric = Object.keys(rule).some((k) => k !== 'exists');
  if (!numeric) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (rule.gt !== undefined && !(value > rule.gt)) return false;
  if (rule.gte !== undefined && !(value >= rule.gte)) return false;
  if (rule.lt !== undefined && !(value < rule.lt)) return false;
  if (rule.lte !== undefined && !(value <= rule.lte)) return false;
  if (rule.eq !== undefined && value !== rule.eq) return false;
  if (rule.ne !== undefined && value === rule.ne) return false;
  return true;
}

/** A nudge fits when all its rules hold and every placeholder has a value. */
export function isNudgeEligible(t: NudgeTemplate, values: Record<string, Value>): boolean {
  for (const [key, rule] of Object.entries(t.when ?? {})) {
    if (!ruleHolds(values[key] ?? null, rule)) return false;
  }
  return placeholdersOf(t).every((k) => values[k] != null && values[k] !== '');
}

export function renderNudge(
  t: NudgeTemplate,
  values: Record<string, Value>,
  formatMoney: (amount: number) => string = formatDynamic,
): RenderedNudge {
  const fill = (s: string) =>
    s.replace(PLACEHOLDER, (_, key: string) => {
      const v = values[key];
      if (v == null) return '';
      if (MONEY_KEYS.has(key)) return formatMoney(Number(v));
      return typeof v === 'number' ? v.toLocaleString('en-US') : v;
    });
  return { id: t.id, category: t.category, tone: t.tone, title: fill(t.title), body: fill(t.body), cta: t.cta };
}

/** How often nudges may appear: at most one per COOLDOWN, only in waking hours. */
export const NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
export const NUDGE_HOURS = { from: 6, to: 21 } as const; // Kampala, [from, to)
export const NUDGE_RECENT_LIMIT = 6;

export interface NudgeHistory {
  lastShownAt: number | null;
  /** Most recent first. */
  recent: string[];
}

export function canShowNudge(history: NudgeHistory, now: Date = new Date()): boolean {
  const h = kampalaHour(now);
  if (h < NUDGE_HOURS.from || h >= NUDGE_HOURS.to) return false;
  return history.lastShownAt == null || now.getTime() - history.lastShownAt >= NUDGE_COOLDOWN_MS;
}

export function recordNudge(history: NudgeHistory, id: string, now: Date = new Date()): NudgeHistory {
  return {
    lastShownAt: now.getTime(),
    recent: [id, ...history.recent.filter((r) => r !== id)].slice(0, NUDGE_RECENT_LIMIT),
  };
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
  const eligible = (opts.templates ?? NUDGES).filter((t) => isNudgeEligible(t, values));
  if (eligible.length === 0) return null;

  const skip = new Set(opts.exclude ?? []);
  const fresh = eligible.filter((t) => !skip.has(t.id));
  const pool = fresh.length > 0 ? fresh : eligible;

  const total = pool.reduce((sum, t) => sum + Math.max(t.weight ?? 1, 0), 0);
  let r = (opts.random ?? Math.random)() * total;
  let chosen = pool[pool.length - 1];
  for (const t of pool) {
    r -= Math.max(t.weight ?? 1, 0);
    if (r < 0) { chosen = t; break; }
  }
  return renderNudge(chosen, values, opts.formatMoney);
}
