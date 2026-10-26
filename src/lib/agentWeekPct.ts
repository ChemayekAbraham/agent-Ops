/**
 * The registering agent's collection percentage for the current Thursday-Wednesday week, as the rent request desks show it.
 *
 * Nothing here measures anything new. Every number comes from `rent_request_agent_week_pct`, which reads the same pieces the agent's own
 * "Weekly performance" screen reads (`get_my_weekly_performance`). The percentage is what has been COLLECTED since Thursday up to now divided by
 * what has been EXPECTED (billed) since Thursday up to now, shown to one decimal, so an officer is never misled by days that have not happened yet.
 * Both amounts start again from nothing every Thursday (the week is Thursday to Wednesday, Kampala time). Collections are capped per Rent Plan at
 * what that plan was due. Current Rent Plans are the main figure; expired Rent Plans are a second figure when the agent has both. The registering
 * agent is the one who registered the tenant, sub-agent or not.
 */

export const AGENT_WEEK_BATCH_LIMIT = 2000;

export interface AgentWeekPct {
  agent_id: string;
  week_start: string;
  week_end: string;
  days_left: number;
  book: 'none' | 'in_window_only' | 'mixed' | 'all_expired';
  in_window_plans: number;
  in_window_collected: number;
  in_window_due_so_far: number;
  in_window_projected_due: number;
  in_window_required_pct: number | null;
  expired_plans: number;
  expired_collected: number;
  expired_due_so_far: number;
  expired_projected_due: number;
  expired_required_pct: number | null;
  last_week_start: string | null;
  last_week_end: string | null;
  last_book: string | null;
  last_in_window_pct: number | null;
  last_expired_pct: number | null;
  last_passes: boolean | null;
}

const num = (v: unknown): number => Number(v) || 0;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

const BOOKS = ['none', 'in_window_only', 'mixed', 'all_expired'] as const;

export function normalizeAgentWeekPct(raw: unknown): AgentWeekPct[] {
  return (Array.isArray(raw) ? raw : [])
    .map((x) => {
      const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const book = BOOKS.includes(r.book as (typeof BOOKS)[number]) ? (r.book as AgentWeekPct['book']) : 'none';
      return {
        agent_id: String(r.agent_id ?? ''),
        week_start: String(r.week_start ?? ''),
        week_end: String(r.week_end ?? ''),
        days_left: num(r.days_left),
        book,
        in_window_plans: num(r.in_window_plans),
        in_window_collected: num(r.in_window_collected),
        in_window_due_so_far: num(r.in_window_due_so_far),
        in_window_projected_due: num(r.in_window_projected_due),
        in_window_required_pct: numOrNull(r.in_window_required_pct),
        expired_plans: num(r.expired_plans),
        expired_collected: num(r.expired_collected),
        expired_due_so_far: num(r.expired_due_so_far),
        expired_projected_due: num(r.expired_projected_due),
        expired_required_pct: numOrNull(r.expired_required_pct),
        last_week_start: strOrNull(r.last_week_start),
        last_week_end: strOrNull(r.last_week_end),
        last_book: strOrNull(r.last_book),
        last_in_window_pct: numOrNull(r.last_in_window_pct),
        last_expired_pct: numOrNull(r.last_expired_pct),
        last_passes: r.last_passes === null || r.last_passes === undefined ? null : r.last_passes === true,
      };
    })
    .filter((r) => r.agent_id);
}

/** collected ÷ expected so far as a percentage. Null when nothing has been expected yet (no figure to show). */
export function weekPctOf(collected: number, due: number): number | null {
  return due > 0 ? (collected / due) * 100 : null;
}

/** "62.5%" — one decimal, exactly as the agent sees it. */
export const formatWeekPct = (p: number): string => `${p.toFixed(1)}%`;

export interface WeekGroup {
  group: 'current' | 'expired';
  pct: number;
  collected: number;
  due: number;
  plans: number;
  required: number | null;
}

export interface AgentWeekSummary {
  /** The figure the desks show and sort by: current Rent Plans when the agent has any, else expired Rent Plans. */
  primary: WeekGroup | null;
  current: WeekGroup | null;
  expired: WeekGroup | null;
}

export function agentWeekSummary(w: AgentWeekPct | null | undefined): AgentWeekSummary {
  if (!w) return { primary: null, current: null, expired: null };
  const cur = weekPctOf(w.in_window_collected, w.in_window_due_so_far);
  const exp = weekPctOf(w.expired_collected, w.expired_due_so_far);
  const current: WeekGroup | null = cur === null ? null : { group: 'current', pct: cur, collected: w.in_window_collected, due: w.in_window_due_so_far, plans: w.in_window_plans, required: w.in_window_required_pct };
  const expired: WeekGroup | null = exp === null ? null : { group: 'expired', pct: exp, collected: w.expired_collected, due: w.expired_due_so_far, plans: w.expired_plans, required: w.expired_required_pct };
  return { primary: current ?? expired, current, expired };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Thu 22 Oct" from an ISO date, without timezone drift. */
export function weekDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return `${WEEKDAYS[dt.getUTCDay()]} ${d} ${MONTHS[dt.getUTCMonth()]}`;
}
export const weekRangeLabel = (start: string | null | undefined, end: string | null | undefined): string => `${weekDay(start)} - ${weekDay(end)}`;

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

/** The text behind the chip: what the percentage is, the amounts, the target, and last week. */
export function agentWeekDetail(w: AgentWeekPct | null | undefined): string {
  const s = agentWeekSummary(w);
  if (!w || !s.primary) {
    return w ? `Nothing has been expected from this agent since Thursday (${weekRangeLabel(w.week_start, w.week_end)}) yet, so there is no collection percentage.` : 'Collection percentage not available.';
  }
  const parts: string[] = [`Collection this week, from ${weekDay(w.week_start)} up to now (the week restarts every Thursday): collected so far divided by expected so far.`];
  const line = (label: string, g: WeekGroup) =>
    `${label}: ${formatWeekPct(g.pct)} - ${ugx(g.collected)} collected of ${ugx(g.due)} expected so far on ${g.plans} Rent Plan${g.plans === 1 ? '' : 's'}${g.required !== null ? `. Needs ${Math.round(g.required * 100)}%` : ''}.`;
  if (s.current) parts.push(line('Current Rent Plans', s.current));
  if (s.expired) parts.push(line('Expired Rent Plans', s.expired));
  if (w.last_week_start && (w.last_in_window_pct !== null || w.last_expired_pct !== null)) {
    const bits: string[] = [];
    if (w.last_in_window_pct !== null) bits.push(`current ${formatWeekPct(w.last_in_window_pct * 100)}`);
    if (w.last_expired_pct !== null) bits.push(`expired ${formatWeekPct(w.last_expired_pct * 100)}`);
    parts.push(`Last week (${weekRangeLabel(w.last_week_start, w.last_week_end)}): ${bits.join(', ')}.`);
  }
  return parts.join(' ');
}

/**
 * Highest percentage first. Agents with no figure go last. Equal percentages keep the order the rows came in, so the desk's own order
 * (best payers, newest ...) still decides between agents on the same percentage. Pure; never mutates `rows`.
 */
export function orderByAgentWeek<T>(rows: T[], byAgent: Map<string, AgentWeekPct> | undefined, agentIdOf: (row: T) => string | null | undefined): T[] {
  if (!byAgent || byAgent.size === 0) return rows;
  const keyed = rows.map((row, i) => {
    const id = agentIdOf(row);
    const p = id ? agentWeekSummary(byAgent.get(id)).primary?.pct ?? null : null;
    return { row, i, p };
  });
  keyed.sort((a, b) => {
    if (a.p === null && b.p === null) return a.i - b.i;
    if (a.p === null) return 1;
    if (b.p === null) return -1;
    return b.p - a.p || a.i - b.i;
  });
  return keyed.map((k) => k.row);
}

export function chunkAgentWeekIds(ids: string[], size = AGENT_WEEK_BATCH_LIMIT): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
