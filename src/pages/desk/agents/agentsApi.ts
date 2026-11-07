import { useQuery } from '@tanstack/react-query';
import { rpc } from '../reviewApi';

/**
 * "Agents live": who is submitting rent requests, how complete those requests
 * are at submission, and where each agent's open requests sit, from
 * `desk_agents_live(p_days)`. Not in the generated Supabase types, so it goes
 * through the `rpc` cast in reviewApi.ts. Read-only.
 */

export type OpenByStage = {
  service_centre: number | null;
  agent_ops: number | null;
  tenant_ops: number | null;
  landlord_ops: number | null;
  coo: number | null;
  funders_board: number | null;
};

export type AgentLiveRow = {
  agent_id: string;
  agent: string | null;
  phone: string | null;
  grade: string | null;
  grade_week_ago: string | null;
  score: number | null;
  flags: string[] | null;
  submitted_today: number | null;
  submitted_period: number | null;
  last_submitted_at: string | null;
  open: OpenByStage | null;
  funded_30d: number | null;
  funded_30d_ugx: number | null;
  bounced_30d: number | null;
  intake_complete_pct: number | null;
  service_centre_person: string | null;
};

export type AgentsLiveSummary = {
  agents_active_today: number | null;
  submitted_today: number | null;
  agents_active_period: number | null;
  submitted_period: number | null;
  flagged_agents_with_open: number | null;
  intake_complete_pct: number | null;
};

export type AgentsLive = {
  days: number | null;
  generated_at: string | null;
  summary: AgentsLiveSummary | null;
  rows: AgentLiveRow[] | null;
};

/** Today, 7 or 30 days. Today asks for one day and reads the `_today` figures. */
export type AgentsWindow = 'today' | 7 | 30;
export const AGENT_WINDOWS: AgentsWindow[] = ['today', 7, 30];
export const daysOf = (w: AgentsWindow): number => (w === 'today' ? 1 : w);
export const windowLabel = (w: AgentsWindow): string => (w === 'today' ? 'Today' : `${w} days`);

export function useAgentsLive(w: AgentsWindow, enabled = true) {
  return useQuery({
    queryKey: ['desk-feed', 'desk-agents-live', daysOf(w)],
    enabled,
    queryFn: async (): Promise<AgentsLive> => {
      const { data, error } = await rpc('desk_agents_live', { p_days: daysOf(w) });
      if (error) throw error;
      return data as AgentsLive;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/* ───────────────────────── pure helpers (tested) ───────────────────────── */

const int = (v: number | null | undefined) => Number(v ?? 0);
const whole = (v: number | null | undefined) => int(v).toLocaleString('en');

/** `intake_complete_pct` is a whole percentage, 0–100 (42 means 42%). Null stays null. */
export function pct(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return Math.round(Number(v));
}

export const pctText = (v: number | null | undefined) => {
  const p = pct(v);
  return p === null ? '—' : `${p}%`;
};

/** Red under 50%, plain otherwise, grey when there is nothing to measure. */
export function intakeTone(v: number | null | undefined): 'bad' | 'plain' | 'idle' {
  const p = pct(v);
  if (p === null) return 'idle';
  return p < 50 ? 'bad' : 'plain';
}

export const submittedIn = (r: AgentLiveRow, w: AgentsWindow) => int(w === 'today' ? r.submitted_today : r.submitted_period);

export const openTotal = (r: AgentLiveRow) =>
  Object.values(r.open ?? {}).reduce<number>((s, v) => s + int(v as number | null), 0);

export const isFlaggedWithOpen = (r: AgentLiveRow) => (r.flags ?? []).length > 0 && openTotal(r) > 0;

/** Flagged agents with open requests first, then the most submitted, then by name. */
export function sortAgents(rows: AgentLiveRow[] | null | undefined, w: AgentsWindow): AgentLiveRow[] {
  return [...(rows ?? [])].sort(
    (a, b) =>
      Number(isFlaggedWithOpen(b)) - Number(isFlaggedWithOpen(a)) ||
      submittedIn(b, w) - submittedIn(a, w) ||
      String(a.agent ?? '').localeCompare(String(b.agent ?? '')),
  );
}

/** "29 agents · 70 requests in 7 days · 0% complete at submission · 10 flagged agents with open requests". */
export function summaryText(s: AgentsLiveSummary | null | undefined, w: AgentsWindow): string {
  const agents = w === 'today' ? s?.agents_active_today : s?.agents_active_period;
  const requests = w === 'today' ? s?.submitted_today : s?.submitted_period;
  const when = w === 'today' ? 'today' : `in ${w} days`;
  return [
    `${whole(agents)} agents`,
    `${whole(requests)} requests ${when}`,
    `${pctText(s?.intake_complete_pct)} complete at submission`,
    `${whole(s?.flagged_agents_with_open)} flagged agents with open requests`,
  ].join(' · ');
}

/** "Today: 20 requests from 12 agents · intake complete 40%". */
export function todayLineText(s: AgentsLiveSummary | null | undefined): string {
  return `Today: ${whole(s?.submitted_today)} requests from ${whole(s?.agents_active_today)} agents · intake complete ${pctText(s?.intake_complete_pct)}`;
}

export const STAGE_PILLS: { key: keyof OpenByStage; short: string; name: string }[] = [
  { key: 'service_centre', short: 'SC', name: 'Service Centre' },
  { key: 'agent_ops', short: 'AO', name: 'Agent Ops' },
  { key: 'tenant_ops', short: 'TO', name: 'Tenant Ops' },
  { key: 'landlord_ops', short: 'LO', name: 'Landlord Ops' },
  { key: 'coo', short: 'COO', name: 'COO' },
  { key: 'funders_board', short: 'Board', name: "Funders' board" },
];

/** The stages where this agent has something open, in pipeline order. */
export const openPills = (r: AgentLiveRow) =>
  STAGE_PILLS.map((p) => ({ ...p, n: int(r.open?.[p.key]) })).filter((p) => p.n > 0);

/** Service Centre sees only the agents with something waiting at the Service Centre. */
export function rowsForDesk(rows: AgentLiveRow[] | null | undefined, deskId: string): AgentLiveRow[] {
  const all = rows ?? [];
  return deskId === 'service-centre' ? all.filter((r) => int(r.open?.service_centre) > 0) : all;
}

export function agentMatches(r: AgentLiveRow, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [r.agent, r.phone, r.service_centre_person, r.grade, ...(r.flags ?? [])].some((v) =>
    String(v ?? '').toLowerCase().includes(s),
  );
}
