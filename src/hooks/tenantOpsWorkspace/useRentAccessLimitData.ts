/**
 * Rent Access Limit block: read-only. Supplies the raw inputs
 * (monthlyRent, repayments) that the EXISTING, already-audited
 * calculateRentAccessLimit()/RentAccessLimitActivity (src/lib/rentAccessLimit.ts,
 * src/components/agent/RentAccessLimitActivity.tsx) already use elsewhere —
 * no new limit math is written here, this hook only gathers their inputs.
 * There is no server-side "current limit" RPC today (confirmed: the figure
 * is always recomputed client-side from raw repayment history), so this is
 * the existing computation path, reused rather than reimplemented.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { RepaymentLike } from '@/lib/rentAccessLimit';

export interface RentAccessLimitData {
  tenantName: string | null;
  monthlyRent: number | null;
  repayments: RepaymentLike[];
}

async function fetchRentAccessLimitData(rentRequestId: string): Promise<RentAccessLimitData> {
  const { data: rr, error: rrError } = await supabase
    .from('rent_requests')
    .select('tenant_id, rent_amount')
    .eq('id', rentRequestId)
    .maybeSingle();
  if (rrError) throw rrError;

  if (!rr?.tenant_id) {
    return { tenantName: null, monthlyRent: null, repayments: [] };
  }

  const [collectionsRes, profileRes] = await Promise.all([
    supabase
      .from('agent_collections')
      .select('amount, created_at')
      .eq('tenant_id', rr.tenant_id)
      .is('reversed_at', null)
      .order('created_at', { ascending: true }),
    supabase.from('profiles').select('full_name').eq('id', rr.tenant_id).maybeSingle(),
  ]);

  return {
    tenantName: profileRes.data?.full_name ?? null,
    monthlyRent: rr.rent_amount ?? null,
    repayments: (collectionsRes.data ?? []).map((c) => ({ amount: c.amount, created_at: c.created_at })),
  };
}

export function useRentAccessLimitData(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'rentAccessLimitData', rentRequestId],
    queryFn: () => fetchRentAccessLimitData(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
