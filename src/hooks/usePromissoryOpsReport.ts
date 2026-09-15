import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type PromissoryRange = 'today' | 'yesterday' | 'weekly' | 'monthly' | 'yearly' | 'all';

export const PROMISSORY_RANGES: { key: PromissoryRange; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'weekly', label: 'This week' },
  { key: 'monthly', label: 'This month' },
  { key: 'yearly', label: 'This year' },
  { key: 'all', label: 'All time' },
];

// EAT (UTC+3) day boundaries expressed as UTC instants
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

function eatStartOfToday(): Date {
  const nowEat = new Date(Date.now() + EAT_OFFSET_MS);
  const y = nowEat.getUTCFullYear();
  const m = nowEat.getUTCMonth();
  const d = nowEat.getUTCDate();
  return new Date(Date.UTC(y, m, d) - EAT_OFFSET_MS);
}

export function resolveRange(range: PromissoryRange): { from: string | null; to: string | null } {
  if (range === 'all') return { from: null, to: null };
  const startToday = eatStartOfToday();
  const day = 24 * 60 * 60 * 1000;
  const nowEat = new Date(Date.now() + EAT_OFFSET_MS);

  switch (range) {
    case 'today':
      return { from: startToday.toISOString(), to: new Date(startToday.getTime() + day).toISOString() };
    case 'yesterday':
      return { from: new Date(startToday.getTime() - day).toISOString(), to: startToday.toISOString() };
    case 'weekly': {
      const dow = (nowEat.getUTCDay() + 6) % 7; // Monday = 0
      const from = new Date(startToday.getTime() - dow * day);
      return { from: from.toISOString(), to: new Date(startToday.getTime() + day).toISOString() };
    }
    case 'monthly': {
      const from = new Date(Date.UTC(nowEat.getUTCFullYear(), nowEat.getUTCMonth(), 1) - EAT_OFFSET_MS);
      return { from: from.toISOString(), to: new Date(startToday.getTime() + day).toISOString() };
    }
    case 'yearly': {
      const from = new Date(Date.UTC(nowEat.getUTCFullYear(), 0, 1) - EAT_OFFSET_MS);
      return { from: from.toISOString(), to: new Date(startToday.getTime() + day).toISOString() };
    }
    default:
      return { from: null, to: null };
  }
}

export interface PromissoryNoteRow {
  id: string;
  agent_id: string | null;
  agent_name: string;
  agent_phone: string | null;
  partner_name: string;
  whatsapp_number: string | null;
  phone_number: string | null;
  email: string | null;
  amount: number;
  total_collected: number;
  outstanding: number;
  contribution_type: string | null;
  deduction_day: number | null;
  next_deduction_date: string | null;
  fulfilment_due_on: string | null;
  status: string;
  created_at: string;
  approved_at: string | null;
  approval_bonus_paid: boolean | null;
  partner_user_id: string | null;
  came_in: boolean;
  came_in_user_id: string | null;
  came_in_name: string | null;
  came_in_at: string | null;
  came_in_match_basis: 'linked_account' | 'whatsapp_number' | 'phone_number' | 'email' | null;
  came_in_matched_value: string | null;
  lead_partner_name: string | null;
  support_mode: 'self_support' | 'existing_support';
  reserved_plans: number;
  reserved_amount: number;
  journey_stage: 'not_registered' | 'came_in' | 'portfolio_pending' | 'portfolio_active';
  portfolio_count: number;
  portfolio_active_count: number;
  portfolio_pending_count: number;
  portfolio_amount: number;
  portfolio_active_amount: number;
  first_portfolio_at: string | null;
  commission_creation_rate: number;
  commission_topup_rate: number;
  creation_commission_paid: number;
  topup_commission_paid: number;
  commission_paid_total: number;
  topup_commission_count: number;
  creation_commission_expected: number;
  last_commission_at: string | null;
  notes?: string | null;
}

export interface ProxyAgentRow {
  agent_user_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  district: string | null;
  region: string | null;
  nin: string | null;
  invite_code: string | null;
  status: string;
  joined_at: string | null;
  notes_count: number;
  partners_count: number;
  lead_partner_name: string | null;
  amount_expected: number;
  amount_collected: number;
}

export interface PromissoryOpsKpis {
  notes_count: number;
  partners_came_in: number;
  partners_with_portfolio: number;
  partners_portfolio_pending: number;
  partners_portfolio_active: number;
  receivable: number;
  promised_total: number;
  fulfilled_total: number;
  approved_notes: number;
  proxy_agents: number;
  proxies_approved: number;
  proxies_pending: number;
  lead_attachments: number;
  pending_commission: number;
  pending_commission_count: number;
  approved_commission: number;
  approved_commission_count: number;
  self_supporting_tenants: number;
  self_supporting_partners: number;
  self_support_committed: number;
  promissory_creation_commission_paid: number;
  promissory_topup_commission_paid: number;
  promissory_commission_paid_total: number;
}

export interface PromissoryCommissionRates {
  portfolio_creation: number;
  portfolio_topup: number;
}

export interface PromissoryOpsReport {
  kpis: PromissoryOpsKpis;
  notes: PromissoryNoteRow[];
  proxy_agents: ProxyAgentRow[];
  rates?: PromissoryCommissionRates;
}


const EMPTY: PromissoryOpsReport = {
  kpis: {
    notes_count: 0, partners_came_in: 0, partners_with_portfolio: 0,
    partners_portfolio_pending: 0, partners_portfolio_active: 0,
    receivable: 0, promised_total: 0, fulfilled_total: 0,
    approved_notes: 0, proxy_agents: 0, proxies_approved: 0, proxies_pending: 0, lead_attachments: 0,
    pending_commission: 0, pending_commission_count: 0, approved_commission: 0, approved_commission_count: 0,
    self_supporting_tenants: 0, self_supporting_partners: 0, self_support_committed: 0,
    promissory_creation_commission_paid: 0, promissory_topup_commission_paid: 0,
    promissory_commission_paid_total: 0,
  },
  notes: [],
  proxy_agents: [],
  rates: { portfolio_creation: 0.02, portfolio_topup: 0.01 },
};

/**
 * Single round-trip report powering the Promissory Notes tab
 * (KPIs + notes list + proxy agent performance). No N+1 client fetches.
 */
export function usePromissoryOpsReport() {
  const [range, setRange] = useState<PromissoryRange>('all');
  const bounds = useMemo(() => resolveRange(range), [range]);

  const query = useQuery({
    queryKey: ['promissory-ops-report', range],
    queryFn: async (): Promise<PromissoryOpsReport> => {
      const { data, error } = await supabase.rpc('get_promissory_ops_report' as any, {
        p_from: bounds.from,
        p_to: bounds.to,
      });
      if (error) throw error;
      const res = (data as any) || {};
      return {
        kpis: { ...EMPTY.kpis, ...(res.kpis || {}) },
        notes: (res.notes || []) as PromissoryNoteRow[],
        proxy_agents: (res.proxy_agents || []) as ProxyAgentRow[],
      };
    },
    staleTime: 60_000,
  });

  return {
    range,
    setRange,
    report: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
