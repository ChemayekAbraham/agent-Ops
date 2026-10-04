/**
 * Header block data: name/phone/trust (ops_tenant_behavior, an existing
 * ops RPC), photo (profiles.avatar_url), KYC level (kyc_profiles +
 * kyc_level_config — existing tables, read-only), plan status
 * (rent_requests.status). All existing sources; nothing new is computed.
 *
 * kyc_profiles' own RLS only allows the tenant themself plus
 * super_admin/manager/cfo/operations — tenant_ops/coo/ceo are not in that
 * policy today. That's a pre-existing gap in that table's policy, not
 * something this hook can or should work around; for those roles the KYC
 * read simply comes back empty and the UI shows "Not visible to your role".
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface TenantHeaderData {
  tenantId: string | null;
  fullName: string | null;
  phone: string | null;
  avatarUrl: string | null;
  trustScore: number | null;
  trustTier: string | null;
  kycLevel: number | null;
  kycLevelLabel: string | null;
  kycVisible: boolean;
  planStatus: string | null;
}

async function fetchTenantHeader(rentRequestId: string): Promise<TenantHeaderData> {
  const { data: rr, error: rrError } = await supabase
    .from('rent_requests')
    .select('tenant_id, status')
    .eq('id', rentRequestId)
    .maybeSingle();
  if (rrError) throw rrError;

  const tenantId: string | null = rr?.tenant_id ?? null;

  const [behaviorRes, profileRes, kycRes] = await Promise.all([
    tenantId ? anyDb.rpc('ops_tenant_behavior', { p_tenant_id: tenantId }) : Promise.resolve({ data: null, error: null }),
    tenantId
      ? supabase.from('profiles').select('avatar_url').eq('id', tenantId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    tenantId
      ? anyDb
          .from('kyc_profiles')
          .select('kyc_level, kyc_level_config:kyc_level_config(label)')
          .eq('user_id', tenantId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const header = behaviorRes.data?.header ?? null;

  return {
    tenantId,
    fullName: header?.full_name ?? null,
    phone: header?.phone ?? null,
    avatarUrl: profileRes.data?.avatar_url ?? null,
    trustScore: header?.trust_score ?? null,
    trustTier: header?.trust_tier ?? null,
    kycLevel: kycRes.data?.kyc_level ?? null,
    kycLevelLabel: kycRes.data?.kyc_level_config?.label ?? null,
    kycVisible: kycRes.data != null,
    planStatus: rr?.status ?? null,
  };
}

export function useTenantHeader(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'tenantHeader', rentRequestId],
    queryFn: () => fetchTenantHeader(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
