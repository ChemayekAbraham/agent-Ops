import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type FunderApprovalStatus = 'approved' | 'pending' | 'rejected' | 'none';

export interface FunderApprovalState {
  status: FunderApprovalStatus;
  rejectionReason: string | null;
  approvedAt: string | null;
  /**
   * Whether the user can fund / back portfolios.
   *
   * For SELF-REGISTERED funders (signed up via `/funder-onboarding`):
   *   `isApproved = true` ONLY after Partner Ops or COO sets
   *   `profiles.funder_verified_at`. Until then, Support Tenant /
   *   Create Portfolio surfaces must be locked.
   *
   * For everyone else (legacy supporters, agent-onboarded supporters, etc.)
   *   `isApproved = true` always — those flows are governed by their own
   *   onboarding paths, not by self-registration verification.
   */
  isApproved: boolean;
  /** True when the profile signed up via /funder-onboarding. */
  isSelfRegistered: boolean;
  /** Timestamp when Partner Ops / COO verified this self-registered funder. */
  verifiedAt: string | null;
  isLoading: boolean;
}

/**
 * Reads the Partner Ops / COO proxy assignment state for a user.
 * Source: `proxy_agent_assignments` (beneficiary_role='supporter').
 *
 * IMPORTANT: This represents PROXY AUTHORITY, NOT permission to fund one's
 * own pool. Self-funding is always allowed for authenticated Supporters.
 */
export function useFunderApprovalStatus(userId: string | null | undefined): FunderApprovalState {
  const { data, isLoading } = useQuery({
    queryKey: ['funder-approval-status', userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      // Read both the RPC (status) and the profile signup_source so we can
      // decide whether verification is required for THIS user.
      const [rpcRes, profileRes] = await Promise.all([
        supabase.rpc('get_funder_approval_status', { _user_id: userId as string }),
        supabase
          .from('profiles')
          .select('signup_source, funder_verified_at')
          .eq('id', userId as string)
          .maybeSingle(),
      ]);
      if (rpcRes.error) throw rpcRes.error;
      const row = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
      const isSelfRegistered = profileRes.data?.signup_source === 'funder-onboarding';
      const verifiedAt = (profileRes.data as any)?.funder_verified_at as string | null | undefined;
      return {
        status: ((row?.status as FunderApprovalStatus) || 'none'),
        rejectionReason: (row?.rejection_reason as string | null) ?? null,
        approvedAt: (row?.approved_at as string | null) ?? null,
        isSelfRegistered,
        verifiedAt: verifiedAt ?? null,
      };
    },
  });

  // All joined users are auto-allowed to invest as long as they have funds
  // in their wallet. Verification is no longer required to fund / back
  // portfolios, so every authenticated funder is treated as approved.
  const isApproved = true;

  return {
    status: data?.status ?? 'none',
    rejectionReason: data?.rejectionReason ?? null,
    approvedAt: data?.approvedAt ?? null,
    isApproved,
    isSelfRegistered: !!data?.isSelfRegistered,
    verifiedAt: data?.verifiedAt ?? null,
    isLoading,
  };
}

/**
 * Proxy authority: can this user act on behalf of OTHER funders?
 * Use ONLY in proxy-management surfaces (deposit on behalf of a managed
 * funder, claim partner commission, "Funders I manage" tab).
 */
export function useProxyAuthority(userId: string | null | undefined) {
  const { data, isLoading } = useQuery({
    queryKey: ['proxy-authority-status', userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_funder_approval_status', {
        _user_id: userId as string,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        status: ((row?.status as FunderApprovalStatus) || 'none'),
        rejectionReason: (row?.rejection_reason as string | null) ?? null,
      };
    },
  });

  return {
    status: data?.status ?? 'none',
    rejectionReason: data?.rejectionReason ?? null,
    hasProxyAuthority: data?.status === 'approved',
    isLoading,
  };
}
