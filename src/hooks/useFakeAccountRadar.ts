import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Fake-account radar (CTO). Read-only heuristics computed server side by
 * `cto_fake_account_signal_counts` / `cto_fake_account_list`, both role-gated
 * to cto / super_admin / manager / ceo. `auth.users` is never client-readable,
 * so all email-confirmation facts come from those SECURITY DEFINER RPCs.
 */

export const FAKE_ACCOUNT_PAGE_SIZE = 25;

export type FakeAccountSignal =
  | 'unverified_email'
  | 'disposable_email'
  | 'duplicate_phone'
  | 'duplicate_national_id'
  | 'duplicate_name'
  | 'suspicious_name'
  | 'dormant'
  | 'burst_signup';

export const FAKE_ACCOUNT_SIGNAL_LABELS: Record<FakeAccountSignal, string> = {
  unverified_email: 'Email never confirmed',
  disposable_email: 'Throwaway email service',
  duplicate_phone: 'Phone used by another account',
  duplicate_national_id: 'National ID used by another account',
  duplicate_name: 'Same name as several unconfirmed accounts',
  suspicious_name: 'Name looks made up',
  dormant: 'Never used after signing up',
  burst_signup: 'Created in a bulk signup burst',
};

export interface FakeAccountCounts {
  total_accounts: number;
  flagged: number;
  high_risk: number;
  unverified_email: number;
  disposable_email: number;
  duplicate_phone: number;
  duplicate_national_id: number;
  duplicate_name: number;
  suspicious_name: number;
  dormant: number;
  burst_signup: number;
  generated_at: string;
}

export interface FakeAccountRow {
  user_id: string;
  full_name: string | null;
  auth_email: string | null;
  phone: string | null;
  created_at: string;
  national_id: string | null;
  last_active_at: string | null;
  email_confirmed: boolean;
  is_synthetic: boolean;
  signals: FakeAccountSignal[];
  risk_score: number;
  total_count: number;
}

export function useFakeAccountCounts(enabled = true) {
  return useQuery({
    queryKey: ['cto-fake-account-counts'],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<FakeAccountCounts> => {
      const { data, error } = await (supabase as any).rpc('cto_fake_account_signal_counts');
      if (error) throw error;
      return data as FakeAccountCounts;
    },
  });
}

export function useFakeAccountList(
  params: { signal: FakeAccountSignal | 'all'; search: string; page: number },
  enabled = true,
) {
  const { signal, search, page } = params;
  return useQuery({
    queryKey: ['cto-fake-account-list', signal, search, page],
    enabled,
    staleTime: 2 * 60 * 1000,
    queryFn: async (): Promise<{ rows: FakeAccountRow[]; total: number }> => {
      const { data, error } = await (supabase as any).rpc('cto_fake_account_list', {
        p_signal: signal,
        p_search: search.trim() || null,
        p_limit: FAKE_ACCOUNT_PAGE_SIZE,
        p_offset: page * FAKE_ACCOUNT_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = ((data || []) as FakeAccountRow[]).map((r) => ({
        ...r,
        signals: (r.signals || []) as FakeAccountSignal[],
      }));
      return { rows, total: rows[0]?.total_count ? Number(rows[0].total_count) : 0 };
    },
  });
}

export function riskBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}
