import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DisputedField =
  | 'owed_to_agent'
  | 'company_cash_with_agent'
  | 'paid_out'
  | 'out_of_pocket'
  | 'float_available';

export const DISPUTED_FIELD_LABELS: Record<DisputedField, string> = {
  owed_to_agent: 'Money you say we owe you',
  company_cash_with_agent: 'Company cash the system says you are holding',
  paid_out: 'Total you have paid out',
  out_of_pocket: 'Your own money used',
  float_available: 'Float available to pay out',
};

export interface MerchantBalanceDispute {
  id: string;
  agentId: string;
  deskId: string | null;
  disputedField: DisputedField;
  systemAmount: number;
  claimedAmount: number | null;
  reason: string;
  status: 'open' | 'reviewing' | 'resolved' | 'rejected';
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  agentName?: string | null;
  agentPhone?: string | null;
}

function mapRow(r: any): MerchantBalanceDispute {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    deskId: r.desk_id ?? null,
    disputedField: (r.disputed_field ?? 'owed_to_agent') as DisputedField,
    systemAmount: Number(r.system_amount ?? 0),
    claimedAmount: r.claimed_amount === null || r.claimed_amount === undefined ? null : Number(r.claimed_amount),
    reason: r.reason ?? '',
    status: r.status ?? 'open',
    resolutionNote: r.resolution_note ?? null,
    resolvedAt: r.resolved_at ?? null,
    createdAt: r.created_at,
  };
}

/** The signed-in merchant agent's own correction requests. */
export function useMyBalanceDisputes(enabled = true) {
  return useQuery({
    queryKey: ['my-balance-disputes'],
    enabled,
    retry: false,
    staleTime: 20_000,
    queryFn: async (): Promise<MerchantBalanceDispute[]> => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return [];
      const { data, error } = await supabase
        .from('merchant_balance_disputes' as any)
        .select('*')
        .eq('agent_id', uid)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return ((data ?? []) as any[]).map(mapRow);
    },
  });
}

/** Every correction request, for the Financial Ops board. */
export function useAllBalanceDisputes(enabled = true) {
  return useQuery({
    queryKey: ['all-balance-disputes'],
    enabled,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 45_000,
    queryFn: async (): Promise<MerchantBalanceDispute[]> => {
      const { data, error } = await supabase
        .from('merchant_balance_disputes' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = ((data ?? []) as any[]).map(mapRow);
      const ids = [...new Set(rows.map((r) => r.agentId))];
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
        rows.forEach((r) => {
          const p = byId.get(r.agentId);
          r.agentName = p?.full_name ?? null;
          r.agentPhone = p?.phone ?? null;
        });
      }
      return rows;
    },
  });
}

export function useRaiseBalanceDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      deskId?: string | null;
      disputedField: DisputedField;
      systemAmount: number;
      claimedAmount?: number | null;
      reason: string;
    }) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error('You must be signed in');
      const { error } = await supabase.from('merchant_balance_disputes' as any).insert({
        agent_id: uid,
        desk_id: input.deskId ?? null,
        disputed_field: input.disputedField,
        system_amount: input.systemAmount,
        claimed_amount: input.claimedAmount ?? null,
        reason: input.reason.trim(),
        status: 'open',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-balance-disputes'] });
      qc.invalidateQueries({ queryKey: ['all-balance-disputes'] });
    },
  });
}

export function useResolveBalanceDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: 'reviewing' | 'resolved' | 'rejected';
      resolutionNote?: string;
    }) => {
      const { data: auth } = await supabase.auth.getUser();
      const patch: Record<string, any> = { status: input.status };
      if (input.resolutionNote !== undefined) patch.resolution_note = input.resolutionNote.trim() || null;
      if (input.status === 'resolved' || input.status === 'rejected') {
        patch.resolved_by = auth.user?.id ?? null;
        patch.resolved_at = new Date().toISOString();
      }
      const { error } = await supabase
        .from('merchant_balance_disputes' as any)
        .update(patch)
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-balance-disputes'] });
      qc.invalidateQueries({ queryKey: ['my-balance-disputes'] });
    },
  });
}
