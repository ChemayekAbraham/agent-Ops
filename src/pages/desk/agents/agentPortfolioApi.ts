import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { rpc } from '../reviewApi';

/**
 * The Agents desk (E61): every agent's rent plans and whether they may bring
 * new requests. Read-only — `desk_agent_portfolio` for the list,
 * `desk_agent_plans` for one agent's sheet. Percentages arrive whole (0–100).
 */

export type PortfolioFilter = 'all' | 'eligible' | 'below' | 'new' | 'frozen_requests';

export type PortfolioSummary = {
  agents: number;
  eligible: number;
  below_50: number;
  new: number;
  frozen_requests: number;
};

export type PortfolioRow = {
  agent_id: string;
  name: string | null;
  phone: string | null;
  grade: string | null;
  plans: number | null;
  active: number | null;
  completed: number | null;
  funded_not_started: number | null;
  plan_value: number | null;
  due_so_far: number | null;
  collected: number | null;
  pct: number | null;
  arrears_active: number | null;
  eligible: boolean;
  new_agent: boolean;
  open_requests: number | null;
  frozen_requests: number | null;
};

export type Portfolio = { summary: PortfolioSummary; rows: PortfolioRow[]; rule: string | null; as_of: string | null };

export type AgentEligibility = {
  eligible: boolean;
  new_agent: boolean;
  pct: number | null;
  plans: number | null;
  open_requests: number | null;
  reason: string | null;
  rule: string | null;
};

export type AgentPlan = {
  rent_request_id: string;
  short_id: string;
  tenant: string | null;
  status: string | null;
  funded_at: string | null;
  starts_on: string | null;
  rent: number | null;
  plan_value: number | null;
  due_so_far: number | null;
  repaid: number | null;
};

export type AgentOpenRequest = {
  rent_request_id: string;
  short_id: string;
  tenant: string | null;
  status: string | null;
  rent: number | null;
  created_at: string | null;
};

export type AgentPlans = {
  agent: { agent_id: string; name: string | null; phone: string | null } | null;
  eligibility: AgentEligibility | null;
  plans: AgentPlan[];
  open_requests: AgentOpenRequest[];
};

export const PORTFOLIO_LIMIT = 500;

/** Below this collection percentage an agent's new requests freeze. */
export const ELIGIBLE_PCT = 50;

export const FILTERS: { value: PortfolioFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'eligible', label: 'Eligible' },
  { value: 'below', label: 'Below 50%' },
  { value: 'new', label: 'New' },
  { value: 'frozen_requests', label: 'Requests frozen' },
];

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function normalizeSummary(s: Partial<PortfolioSummary> | null | undefined): PortfolioSummary {
  return {
    agents: num(s?.agents),
    eligible: num(s?.eligible),
    below_50: num(s?.below_50),
    new: num(s?.new),
    frozen_requests: num(s?.frozen_requests),
  };
}

/** True when a whole percentage is under the 50% line. Unknown (no plan due yet) is not "under". */
export function isBelow(pct: number | null | undefined): boolean {
  return pct !== null && pct !== undefined && Number.isFinite(Number(pct)) && Number(pct) < ELIGIBLE_PCT;
}

/** One plan's repaid against its due so far, whole; null when nothing is due yet. */
export function planPct(p: Pick<AgentPlan, 'due_so_far' | 'repaid'>): number | null {
  const due = Number(p.due_so_far);
  if (!Number.isFinite(due) || due <= 0) return null;
  return (100 * num(p.repaid)) / due;
}

const STATUS_WORDS: Record<string, string> = {
  funded: 'Not started',
  repaying: 'Repaying',
  completed: 'Completed',
  defaulted: 'Defaulted',
  service_center_review: 'Service Centre',
  pending: 'Agent Ops',
  agent_ops_approved: 'Tenant Ops',
  tenant_ops_approved: 'Landlord Ops',
  landlord_ops_approved: 'Partner Ops',
  partner_ops_approved: 'COO',
  coo_approved: 'Funders',
};

/** A plan or request status in desk words: "Repaying", "Not started"; open requests by the desk they wait at. */
export function statusWords(s: string | null | undefined): string {
  if (!s) return '—';
  return STATUS_WORDS[s] ?? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** "3 / 1 / 0" — active, completed, not started. */
export function plansText(r: Pick<PortfolioRow, 'active' | 'completed' | 'funded_not_started'>): string {
  return `${num(r.active)} / ${num(r.completed)} / ${num(r.funded_not_started)}`;
}

export async function loadPortfolio(search: string, filter: PortfolioFilter): Promise<Portfolio> {
  const { data, error } = await rpc('desk_agent_portfolio', {
    p_search: search.trim() || null,
    p_filter: filter,
    p_limit: PORTFOLIO_LIMIT,
  });
  if (error) throw error;
  const d = (data ?? {}) as Partial<Portfolio> & { summary?: Partial<PortfolioSummary> };
  return {
    summary: normalizeSummary(d.summary),
    rows: Array.isArray(d.rows) ? d.rows : [],
    rule: typeof d.rule === 'string' ? d.rule : null,
    as_of: typeof d.as_of === 'string' ? d.as_of : null,
  };
}

export function useAgentPortfolio(search: string, filter: PortfolioFilter) {
  return useQuery({
    queryKey: ['desk-feed', 'agent-portfolio', search.trim(), filter],
    queryFn: () => loadPortfolio(search, filter),
    placeholderData: (prev) => prev,
    refetchInterval: 120_000,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useAgentPlans(agentId: string | null) {
  return useQuery({
    queryKey: ['desk-feed', 'agent-plans', agentId],
    enabled: !!agentId,
    queryFn: async (): Promise<AgentPlans> => {
      const { data, error } = await rpc('desk_agent_plans', { p_agent: agentId });
      if (error) throw error;
      const d = (data ?? {}) as Partial<AgentPlans>;
      return {
        agent: d.agent ?? null,
        eligibility: d.eligibility ?? null,
        plans: Array.isArray(d.plans) ? d.plans : [],
        open_requests: Array.isArray(d.open_requests) ? d.open_requests : [],
      };
    },
    staleTime: 30_000,
    retry: 1,
  });
}

/** The one row whose name matches exactly (case and spacing aside); null when none or several do. */
export function uniqueByName(rows: Pick<PortfolioRow, 'agent_id' | 'name'>[], name: string): string | null {
  const key = name.trim().replace(/\s+/g, ' ').toLowerCase();
  const hits = rows.filter((r) => (r.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === key);
  return hits.length === 1 ? hits[0].agent_id : null;
}

/**
 * The agent behind a request, for boards whose rows carry only the agent's
 * name (the COO board). Reads the request's assigned agent (else the agent who
 * brought it); where the request cannot be read, falls back to the one agent
 * with exactly that name. Read-only.
 */
export async function resolveRequestAgent(requestId: string, name: string | null): Promise<string | null> {
  const { data, error } = await supabase
    .from('rent_requests')
    .select('agent_id, assigned_agent_id')
    .eq('id', requestId)
    .maybeSingle();
  const r = data as { agent_id: string | null; assigned_agent_id: string | null } | null;
  const id = error ? null : (r?.assigned_agent_id ?? r?.agent_id ?? null);
  if (id) return id;
  if (!name || name === '—') return null;
  const found = await loadPortfolio(name, 'all');
  return uniqueByName(found.rows, name);
}

export function useRequestAgent(requestId: string | null, name: string | null) {
  return useQuery({
    queryKey: ['desk-feed', 'request-agent', requestId],
    enabled: !!requestId,
    queryFn: () => resolveRequestAgent(requestId as string, name),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
