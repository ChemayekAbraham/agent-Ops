/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface MerchantDeskOption {
  agentId: string;
  label: string;
  fullName: string;
  /** false for desks that are inactive or retired; the list is sorted active-first. */
  isActive: boolean;
}

export interface MerchantDeskDailyTrackerRow {
  agent_id: string | null;
  desk_label: string;
  day: string;
  given_ledger: number;
  given_external_confirmed: number;
  given_external_suggested: number;
  taken_back: number;
  used: number;
  payouts?: number;
  bank_payouts_amount?: number;
  running_confirmed: number;
  running_with_suggested: number;
  oop_outstanding_confirmed: number | null;
  oop_outstanding_with_suggested: number | null;
}

export interface MerchantExternalFundingTransfer {
  id: string;
  agent_id: string;
  amount: number;
  funded_at: string;
  channel: 'bank_transfer' | 'mtn_to_bank' | 'airtel_to_bank' | 'cash' | 'other' | string;
  reference: string | null;
  source_account: string | null;
  destination_account: string | null;
  status: 'suggested' | 'confirmed' | 'rejected' | string;
  note: string | null;
  decided_at: string | null;
}

export const IMMACULATE_PRESET = {
  label: 'Immaculate (both desks)',
  agentIds: [
    '1a88b1b8-6601-477b-b119-8e18d5dc9ebd', // BAITA, the bank desk
    '27d5a08b-5fee-452e-bc9a-bc8064f96ae3', // Merchant Agent, the Airtel desk
  ],
};

export const TRACKER_MIN_DATE = '2026-09-01';

export function useMerchantDesksList() {
  return useQuery({
    queryKey: ['merchant-desks-list'],
    staleTime: 60_000,
    queryFn: async (): Promise<MerchantDeskOption[]> => {
      const { data, error } = await supabase
        .from('cashout_agents')
        .select('agent_id, label, is_active, retired_at, profiles:agent_id(id, full_name)')
        .not('agent_id', 'is', null)
        .order('label', { ascending: true });

      if (error) throw error;

      return (data || [])
        .filter((row: any) => Boolean(row.agent_id))
        .map((row: any) => {
          const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
          return {
            agentId: row.agent_id as string,
            label: row.label || 'Merchant desk',
            fullName: profile?.full_name || 'Merchant agent',
            isActive: row.is_active !== false && !row.retired_at,
          };
        })
        // 8 of 25 desks are retired/inactive; keep them selectable (history) but last.
        .sort((a, b) => Number(b.isActive) - Number(a.isActive));
    },
  });
}

export function useMerchantDeskFundingTracker(params: {
  agentIds: string[];
  fromDate?: string;
  toDate?: string;
  enabled?: boolean;
}) {
  const { agentIds, fromDate = TRACKER_MIN_DATE, toDate, enabled = true } = params;

  return useQuery({
    queryKey: ['merchant-desk-funding-tracker', [...agentIds].sort().join(','), fromDate, toDate],
    enabled: enabled && agentIds.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<MerchantDeskDailyTrackerRow[]> => {
      const { data, error } = await supabase.rpc('get_merchant_desk_funding_tracker' as any, {
        p_agent_ids: agentIds,
        p_from: fromDate || TRACKER_MIN_DATE,
        p_to: toDate || undefined,
      });

      if (error) throw error;
      return (data || []) as MerchantDeskDailyTrackerRow[];
    },
  });
}

export function useMerchantDeskExternalFunding(agentIds: string[], enabled = true) {
  return useQuery({
    queryKey: ['merchant-desk-external-funding', [...agentIds].sort().join(',')],
    enabled: enabled && agentIds.length > 0,
    staleTime: 15_000,
    queryFn: async (): Promise<MerchantExternalFundingTransfer[]> => {
      const { data, error } = await supabase
        .from('merchant_desk_external_funding' as any)
        .select(
          'id, agent_id, amount, funded_at, channel, reference, source_account, destination_account, status, note, decided_at'
        )
        .in('agent_id', agentIds)
        .order('funded_at', { ascending: false });

      if (error) throw error;
      return (data || []) as MerchantExternalFundingTransfer[];
    },
  });
}

export function useDecideMerchantDeskExternalFunding() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: 'confirmed' | 'rejected' | 'suggested';
      note?: string | null;
    }) => {
      const { error } = await supabase.rpc('decide_merchant_desk_external_funding' as any, {
        p_id: input.id,
        p_status: input.status,
        p_note: input.note ?? null,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-desk-external-funding'] });
      qc.invalidateQueries({ queryKey: ['merchant-desk-funding-tracker'] });
      qc.invalidateQueries({ queryKey: ['merchant-float-positions'] });
    },
  });
}

export function useRecordMerchantDeskExternalFunding() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      agentId: string;
      amount: number;
      fundedAt: string; // ISO string
      channel: string;
      reference?: string | null;
      note?: string | null;
    }) => {
      const { error } = await supabase.rpc('record_merchant_desk_external_funding' as any, {
        p_agent_id: input.agentId,
        p_amount: input.amount,
        p_funded_at: input.fundedAt,
        p_channel: input.channel,
        p_reference: input.reference ?? null,
        p_note: input.note ?? null,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-desk-external-funding'] });
      qc.invalidateQueries({ queryKey: ['merchant-desk-funding-tracker'] });
      qc.invalidateQueries({ queryKey: ['merchant-float-positions'] });
    },
  });
}
