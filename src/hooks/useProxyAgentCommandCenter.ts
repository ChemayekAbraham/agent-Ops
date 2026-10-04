import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Data layer for the Proxy Agent Command Center.
 *
 * Every figure comes from a single server-side aggregate RPC so the page never
 * fans out into N+1 queries. The RPCs are SECURITY DEFINER and self-gate to the
 * calling proxy agent (or an ops/executive reviewer), so no client-side scoping
 * is required here.
 */

export interface ProxyCommandCenterSummary {
  agent_id: string;
  generated_at: string;
  partners: {
    onboarded: number;
    came_in: number;
    returning: number;
    total_funded: number;
    today: number;
    this_week: number;
    this_month: number;
  };
  notes: {
    total: number;
    pending: number;
    activated: number;
    rejected: number;
    linked_partners: number;
    total_amount: number;
    total_collected: number;
  };
  commission: {
    two_percent: number;
    one_percent: number;
    note_rewards: number;
    total: number;
    this_month: number;
  };
  pending_commission: { pending_notes: number; rate_per_note: number; amount: number };
  earnings: { total: number; withdrawable: number };
  rates: {
    investment_commission_pct: number;
    partner_deposit_commission_pct: number;
    note_reward: number;
  };
  targets: { monthly_partner_target: number; month_progress_pct: number };
  invites: { shared: number; clicked: number; converted: number };
}

export interface ProxyPartnerRow {
  partner_user_id: string;
  partner_name: string;
  partner_phone: string;
  sources: string[];
  linked_at: string;
  portfolios: number;
  total_funded: number;
  last_funded_at: string | null;
  came_in: boolean;
  is_returning: boolean;
  notes_count: number;
}

export interface ProxyNoteRow {
  id: string;
  partner_name: string;
  whatsapp_number: string | null;
  phone_number: string | null;
  amount: number;
  contribution_type: string | null;
  status: string;
  total_collected: number;
  partner_user_id: string | null;
  linked_partner_name: string | null;
  linked_partner_phone: string | null;
  partner_portfolios: number;
  partner_came_in: boolean;
  approval_bonus_paid: boolean;
  approved_at: string | null;
  created_at: string;
}

interface Paged<T> {
  total: number;
  limit: number;
  offset: number;
  rows: T[];
}

export function useProxyCommandCenterSummary(agentId?: string | null) {
  return useQuery({
    queryKey: ['proxy-cc-summary', agentId ?? 'self'],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async (): Promise<ProxyCommandCenterSummary> => {
      const { data, error } = await supabase.rpc('get_proxy_agent_command_center', {
        p_agent_id: agentId ?? null,
      });
      if (error) throw new Error(error.message);
      return data as unknown as ProxyCommandCenterSummary;
    },
  });
}

export interface PartnerListArgs {
  agentId?: string | null;
  search: string;
  filter: 'all' | 'came_in' | 'returning' | 'not_yet';
  sort: 'linked_at' | 'name' | 'funded' | 'portfolios';
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export function useProxyPartnerList(args: PartnerListArgs) {
  const { agentId, search, filter, sort, dir, page, pageSize } = args;
  return useQuery({
    queryKey: ['proxy-cc-partners', agentId ?? 'self', search, filter, sort, dir, page, pageSize],
    enabled: !!agentId,
    staleTime: 30_000,
    queryFn: async (): Promise<Paged<ProxyPartnerRow>> => {
      const { data, error } = await supabase.rpc('list_proxy_agent_partners', {
        p_agent_id: agentId ?? null,
        p_search: search || null,
        p_filter: filter,
        p_sort: sort,
        p_dir: dir,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw new Error(error.message);
      return data as unknown as Paged<ProxyPartnerRow>;
    },
  });
}

export interface NoteListArgs {
  agentId?: string | null;
  search: string;
  status: string;
  sort: 'created_at' | 'amount' | 'partner' | 'status';
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export function useProxyNoteList(args: NoteListArgs) {
  const { agentId, search, status, sort, dir, page, pageSize } = args;
  return useQuery({
    queryKey: ['proxy-cc-notes', agentId ?? 'self', search, status, sort, dir, page, pageSize],
    enabled: !!agentId,
    staleTime: 30_000,
    queryFn: async (): Promise<Paged<ProxyNoteRow>> => {
      const { data, error } = await supabase.rpc('list_proxy_agent_promissory_notes', {
        p_agent_id: agentId ?? null,
        p_search: search || null,
        p_status: status,
        p_sort: sort,
        p_dir: dir,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw new Error(error.message);
      return data as unknown as Paged<ProxyNoteRow>;
    },
  });
}
