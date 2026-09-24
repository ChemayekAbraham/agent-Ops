import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ShareStatus = 'awaiting_signature' | 'submitted' | 'completed' | 'cancelled';

export interface ShareRequestRow {
  id: string;
  shareholder_id: string;
  shareholder_full_name: string | null;
  shareholder_phone: string | null;
  shareholder_email: string | null;
  created_by_name: string | null;
  amount: number;
  shares: number;
  pool_ownership_percent: number;
  company_ownership_percent: number;
  reference_id: string;
  status: ShareStatus;
  shareholder_name: string | null;
  shareholder_signature_data_url: string | null;
  shareholder_signed_at: string | null;
  company_rep_name: string | null;
  company_rep_position: string | null;
  company_signed_at: string | null;
  pdf_path: string | null;
  token_expires_at: string | null;
  created_at: string;
  total_count: number;
}

export const SHARE_KEY = ['share-onboarding'] as const;

/** One RPC per page — names are joined server-side (no N+1). */
export function useShareRequests(statuses: ShareStatus[] | null, search: string) {
  return useQuery({
    queryKey: [...SHARE_KEY, statuses?.join(',') ?? 'all', search],
    queryFn: async () => {
      const single = statuses && statuses.length === 1 ? statuses[0] : null;
      const { data, error } = await supabase.rpc('share_onboarding_list' as any, {
        p_status: single, p_search: search || null, p_limit: 200, p_offset: 0,
      });
      if (error) throw error;
      const rows = (data ?? []) as ShareRequestRow[];
      return statuses && statuses.length > 1 ? rows.filter((r) => statuses.includes(r.status)) : rows;
    },
    staleTime: 15_000,
  });
}

export function useInvalidateShares() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SHARE_KEY });
}

/** Invoke an edge function and surface its JSON error message. */
export async function invokeShareFn<T = any>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export const SHARE_STATUS_LABEL: Record<ShareStatus, string> = {
  awaiting_signature: 'Awaiting signature',
  submitted: 'Submitted',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
