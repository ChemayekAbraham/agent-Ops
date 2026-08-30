/**
 * proxyAgentDirectory — single source of truth for the Partner Ops
 * "Proxy Agent" directory (list + detail sheet).
 *
 * Performance rules:
 *  - ONE RPC per screen: `partner_ops_proxy_agent_directory` returns the four
 *    KPI aggregates AND the paged rows together (no separate count query, no
 *    per-row lookups → no N+1).
 *  - The detail sheet is likewise ONE RPC returning bio + notes + partners +
 *    earnings, so opening a proxy agent costs a single round trip.
 *  - Shared types/labels live here so list and sheet never drift (DRY).
 */
import { supabase } from '@/integrations/supabase/client';

export const PROXY_DIR_PAGE_SIZE = 30;

export interface ProxyDirRow {
  agent_user_id: string;
  name: string;
  status: string;
  avatar_url: string | null;
  phone: string | null;
  email: string | null;
  district: string | null;
  nin: string | null;
  invite_code: string | null;
  joined_at: string | null;
  approved_at: string | null;
  referrer_name: string | null;
  lead_name: string | null;
  notes_count: number;
  notes_pending: number;
  notes_activated: number;
  notes_amount: number;
  notes_collected: number;
  partners_linked: number;
  partners_came_in: number;
  partner_funded: number;
  earned: number;
}

export interface ProxyDirKpis {
  agents_total: number;
  agents_approved: number;
  agents_suspended: number;
  partners_linked: number;
  partners_came_in: number;
  partner_funded: number;
  notes_count: number;
  notes_pending: number;
  notes_amount: number;
  notes_collected: number;
  earned: number;
  active_producers: number;
}

export interface ProxyDirPage {
  total: number;
  limit: number;
  offset: number;
  rows: ProxyDirRow[];
  kpis: ProxyDirKpis;
}

export interface ProxyNote {
  id: string;
  partner_name: string | null;
  partner_user_id: string | null;
  phone: string | null;
  amount: number;
  collected: number;
  status: string;
  contribution_type: string | null;
  deduction_day: number | null;
  next_deduction_date: string | null;
  created_at: string;
  approved_at: string | null;
}

export interface ProxyPartner {
  partner_user_id: string;
  partner_name: string;
  partner_phone: string | null;
  avatar_url: string | null;
  sources: string[] | null;
  linked_at: string | null;
  portfolios: number;
  total_funded: number;
  last_funded_at: string | null;
  came_in: boolean;
  is_returning: boolean;
  notes_count: number;
  support_type: 'self_support' | 'managed_support';
  portfolio_status: string | null;
  active_portfolios: number;
  locked_portfolios: number;
}

export interface ProxyEarning {
  id: string;
  transaction_date: string;
  amount: number;
  category: string;
  description: string | null;
  linked_party: string | null;
}

export interface ProxyDetail {
  bio: {
    agent_user_id: string;
    name: string;
    status: string;
    nin: string | null;
    invite_code: string | null;
    submitted_at: string | null;
    approved_at: string | null;
    review_notes: string | null;
    avatar_url: string | null;
    phone: string | null;
    email: string | null;
    district: string | null;
    national_id: string | null;
    joined_at: string | null;
    referrer_name: string | null;
    lead_name: string | null;
  };
  notes: ProxyNote[];
  partners: ProxyPartner[];
  earnings: ProxyEarning[];
  earnings_total: number;
}

export async function fetchProxyDirectory(
  search: string,
  status: string,
  offset: number,
  limit: number = PROXY_DIR_PAGE_SIZE,
): Promise<ProxyDirPage> {
  const { data, error } = await supabase.rpc('partner_ops_proxy_agent_directory', {
    p_search: search.trim() || null,
    p_status: status,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return data as unknown as ProxyDirPage;
}

/* ---------------------------------------------------------------------------
 * Monthly target for every proxy agent (one target, applied to all agents).
 * ------------------------------------------------------------------------ */

export type ProxyTargetMetric = 'partners_came_in' | 'notes_activated' | 'capital_raised';

export const PROXY_TARGET_METRICS: {
  key: ProxyTargetMetric;
  label: string;
  helper: string;
  money: boolean;
}[] = [
  {
    key: 'partners_came_in',
    label: 'Partners who put in money',
    helper: 'How many new partners each proxy agent should bring in this month.',
    money: false,
  },
  {
    key: 'notes_activated',
    label: 'Promissory notes activated',
    helper: 'How many signed notes each proxy agent should get activated this month.',
    money: false,
  },
  {
    key: 'capital_raised',
    label: 'Capital raised',
    helper: 'How much money each proxy agent should raise this month.',
    money: true,
  },
];

export interface ProxyTargetOverview {
  period_month: string;
  agents_total: number;
  targets: Partial<Record<ProxyTargetMetric, { target_value: number; note: string | null; set_at: string }>>;
  metrics: Record<ProxyTargetMetric, { achieved_total: number; started: number; hit: number }>;
}

export async function fetchProxyTargetOverview(month: string): Promise<ProxyTargetOverview> {
  const { data, error } = await supabase.rpc('partner_ops_proxy_agent_target_overview', {
    p_month: `${month}-01`,
  });
  if (error) throw error;
  return data as unknown as ProxyTargetOverview;
}

export async function setProxyTarget(args: {
  metric: ProxyTargetMetric;
  month: string;
  target: number;
  note?: string;
}) {
  const { error } = await supabase.rpc('partner_ops_set_proxy_agent_target', {
    p_metric_key: args.metric,
    p_month: `${args.month}-01`,
    p_target: args.target,
    p_note: args.note?.trim() || null,
  });
  if (error) throw error;
}


export async function fetchProxyDetail(agentUserId: string): Promise<ProxyDetail> {
  const { data, error } = await supabase.rpc('partner_ops_proxy_agent_detail', {
    p_agent_user_id: agentUserId,
  });
  if (error) throw error;
  return data as unknown as ProxyDetail;
}

/** Presentation helpers shared by the list and the sheet (DRY). */
export function proxyInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || 'PA';
}

export function supportTypeLabel(type: ProxyPartner['support_type']): string {
  return type === 'self_support' ? 'Self support' : 'Managed support';
}

export function proxyStatusTone(status: string): string {
  if (status === 'approved') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600';
  if (status === 'suspended') return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-amber-500/40 bg-amber-500/10 text-amber-600';
}

export const PROXY_SOURCE_LABELS: Record<string, string> = {
  invite: 'Invite',
  proxy: 'Proxy link',
  referral: 'Referral',
  portfolio: 'Portfolio',
  note: 'Promissory',
  invite_link: 'Share link',
};
