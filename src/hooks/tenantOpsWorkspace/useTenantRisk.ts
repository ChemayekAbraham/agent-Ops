/**
 * Risk block: duplicates and restructure history, read from existing
 * tables/RPCs only. Idle state is read by the component from
 * usePlanPosition's own days_past_due (already fetched for PositionCard;
 * React Query dedupes the identical query rather than re-fetching), since no
 * dedicated "idle" table or RPC exists today — recorded as an interpretation
 * choice in docs/TOPS_BUILD_LOG.md.
 *
 * Renewal is an INFERENCE, not a stored fact (docs/TOPS_FINDINGS.md §7: no
 * column links a renewal to what it renewed) — this hook only checks whether
 * the inference signals are present, it does not assert a specific chain.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface TenantRiskData {
  duplicateAlert: {
    status: string;
    matchType: string;
    memberCount: number;
  } | null;
  pauseCount: number;
  latestPauseStatus: string | null;
  isRenewal: boolean;
  wasLaterRenewed: boolean;
  reopenCount: number;
  reopenReason: string | null;
  /** True when any restructure signal is present — the plan stays in the risk numerator. */
  remainsInRiskNumerator: boolean;
}

async function fetchTenantRisk(rentRequestId: string): Promise<TenantRiskData> {
  const { data: rr, error: rrError } = await supabase
    .from('rent_requests')
    .select('tenant_id, registration_type, created_at, reopen_count, reopen_reason')
    .eq('id', rentRequestId)
    .maybeSingle();
  if (rrError) throw rrError;

  const tenantId = rr?.tenant_id ?? null;
  const isRenewal = rr?.registration_type === 'renewal';
  const reopenCount = rr?.reopen_count ?? 0;

  const [dupRes, pauseRes, laterRenewalRes] = await Promise.all([
    tenantId
      ? anyDb
          .from('tenant_phone_duplicate_alerts')
          .select('status, match_type, member_count')
          .contains('member_ids', [tenantId])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    anyDb
      .from('rent_repayment_pauses')
      .select('status')
      .eq('rent_request_id', rentRequestId)
      .order('paused_at', { ascending: false }),
    tenantId && rr?.created_at
      ? supabase
          .from('rent_requests')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('registration_type', 'renewal')
          .gt('created_at', rr.created_at)
          .limit(1)
      : Promise.resolve({ data: [] }),
  ]);

  const pauses = pauseRes.data ?? [];
  const wasLaterRenewed = (laterRenewalRes.data ?? []).length > 0;

  return {
    duplicateAlert: dupRes.data
      ? { status: dupRes.data.status, matchType: dupRes.data.match_type, memberCount: dupRes.data.member_count }
      : null,
    pauseCount: pauses.length,
    latestPauseStatus: pauses[0]?.status ?? null,
    isRenewal,
    wasLaterRenewed,
    reopenCount,
    reopenReason: rr?.reopen_reason ?? null,
    remainsInRiskNumerator: pauses.length > 0 || isRenewal || wasLaterRenewed || reopenCount > 0,
  };
}

export function useTenantRisk(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'tenantRisk', rentRequestId],
    queryFn: () => fetchTenantRisk(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
