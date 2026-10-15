// Types and small pure helpers for the Agent Ops "Agent Network" tab.
//
// Everything shown comes from one server function, get_agent_ops_network_overview. The tab shows its figures exactly as returned: nothing here
// adds, averages, ranks or re-derives a number. What is here: the Kampala days sent to the server, turning the rpc's JSON into a typed value
// (a missing figure reads as 0 / an empty list so a zero payload renders), and one plain line for an error.
import { format } from 'date-fns';
import { kampalaTodayYmd } from '@/lib/kampalaDays';

export interface NetworkCounts {
  agents: number;
  with_service_centres: number;
  with_bikes: number;
  with_smartphone_plan: number;
  with_smartphone_tenants: number;
  with_subagents: number;
  posted_requests: number;
  approved_agents: number;
}

export interface NetworkApproved {
  agents: number;
  requests: number;
  amount: number;
  receivables_outstanding: number;
}

interface RankedBase {
  agent_id: string;
  name: string;
  phone: string | null;
}
export interface PortfolioRow extends RankedBase { portfolio: number; plans: number }
export interface CollectionRateRow extends RankedBase { collected: number; expected: number; rate_pct: number }
export interface DefaultRateRow extends RankedBase { outstanding: number; defaulted: number; default_rate_pct: number; plans: number }

export interface AgentNetworkOverview {
  range: { start: string; end: string; min_expected: number };
  counts: NetworkCounts;
  approved: NetworkApproved;
  top_portfolios: PortfolioRow[];
  top_collection_rate: CollectionRateRow[];
  default_rate_ascending: DefaultRateRow[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const base = (r: Obj): RankedBase => ({
  agent_id: String(r.agent_id ?? ''),
  name: String(r.name ?? 'Unnamed agent'),
  phone: r.phone == null || r.phone === '' ? null : String(r.phone),
});

/** The server's answer as a typed value. A figure that is missing reads as 0 and a missing list as empty. */
export function normalizeNetworkOverview(raw: unknown): AgentNetworkOverview {
  const r = obj(raw);
  const c = obj(r.counts);
  const a = obj(r.approved);
  const range = obj(r.range);
  return {
    range: { start: String(range.start ?? ''), end: String(range.end ?? ''), min_expected: num(range.min_expected) },
    counts: {
      agents: num(c.agents),
      with_service_centres: num(c.with_service_centres),
      with_bikes: num(c.with_bikes),
      with_smartphone_plan: num(c.with_smartphone_plan),
      with_smartphone_tenants: num(c.with_smartphone_tenants),
      with_subagents: num(c.with_subagents),
      posted_requests: num(c.posted_requests),
      approved_agents: num(c.approved_agents),
    },
    approved: { agents: num(a.agents), requests: num(a.requests), amount: num(a.amount), receivables_outstanding: num(a.receivables_outstanding) },
    top_portfolios: list(r.top_portfolios).map((x) => ({ ...base(x), portfolio: num(x.portfolio), plans: num(x.plans) })),
    top_collection_rate: list(r.top_collection_rate).map((x) => ({ ...base(x), collected: num(x.collected), expected: num(x.expected), rate_pct: num(x.rate_pct) })),
    default_rate_ascending: list(r.default_rate_ascending).map((x) => ({
      ...base(x), outstanding: num(x.outstanding), defaulted: num(x.defaulted), default_rate_pct: num(x.default_rate_pct), plans: num(x.plans),
    })),
  };
}

/**
 * The Kampala days to ask for. The page's range picker gives calendar days; the day the picker shows is the day sent. The end is never
 * later than Kampala today (the server refuses a future day) and the start is never after the end.
 */
export function networkRangeParams(start: Date, end: Date, today: string = kampalaTodayYmd()): { p_start: string; p_end: string } {
  const e = format(end, 'yyyy-MM-dd');
  const s = format(start, 'yyyy-MM-dd');
  const pEnd = e > today ? today : e;
  const pStart = s > pEnd ? pEnd : s;
  return { p_start: pStart, p_end: pEnd };
}

/** One plain line for an error from the function. Never empty. */
export function networkErrorMessage(raw: unknown): string {
  const text = String((raw as { message?: string } | null)?.message ?? raw ?? '').trim();
  if (text.includes('auth_required')) return 'Your session expired. Sign in again and retry.';
  if (text.includes('not_authorized') || (raw as { code?: string } | null)?.code === '42501') return 'You do not have access to the Agent Network figures.';
  if (text.includes('RANGE_FUTURE')) return 'Pick a range that ends today or earlier.';
  if (text.includes('RANGE_INVALID')) return 'The end date is before the start date.';
  if (text.includes('RANGE_REQUIRED')) return 'Pick a start and an end date.';
  return text.split('\n')[0].replace(/^[A-Z_]{4,}:\s*/, '').trim() || 'Something went wrong. Please try again.';
}
