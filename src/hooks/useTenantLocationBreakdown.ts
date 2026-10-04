import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type TenantLocationLevel = 'country' | 'region' | 'district' | 'ward' | 'agent' | 'landlord';

export interface TenantBreadcrumbPath {
  country?: string;
  region?: string;
  district?: string;
  ward?: string;
  /** Official ug_districts id when the row resolved to the dataset */
  districtId?: number | null;
  /** Official ug_subcounties id */
  subcountyId?: number | null;
  agentId?: string | null;
  agentName?: string;
  landlordId?: string | null;
  landlordName?: string;
}

export interface TenantBreakdownRow {
  key: string;
  label: string;
  agent_id: string | null;
  landlord_id: string | null;
  agent_name: string | null;
  landlord_name: string | null;
  total: number;
  occupied: number;
  vacant: number;
  hidden: number;
  revenue_ugx: number;
  district_id?: number | null;
  subcounty_id?: number | null;
}

export function tenantNextLevel(p: TenantBreadcrumbPath): TenantLocationLevel | 'tenants' {
  if (!p.country) return 'country';
  if (!p.region) return 'region';
  if (!p.district) return 'district';
  if (!p.ward) return 'ward';
  if (p.agentId === undefined) return 'agent';
  if (p.landlordId === undefined) return 'landlord';
  return 'tenants';
}

export interface TenantFundedWindow {
  fundedSince?: string | null; // ISO timestamp
  fundedUntil?: string | null; // ISO timestamp
}

export function useTenantLocationBreakdown(
  path: TenantBreadcrumbPath,
  window: TenantFundedWindow = {},
) {
  const level = tenantNextLevel(path);
  return useQuery({
    enabled: level !== 'tenants',
    queryKey: [
      'tenant-location-breakdown', level,
      path.country, path.region, path.district, path.ward,
      path.districtId, path.subcountyId, path.agentId,
      window.fundedSince ?? null, window.fundedUntil ?? null,
    ],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_location_breakdown' as any, {
        p_level: level,
        p_country: path.country ?? null,
        p_region: path.region ?? null,
        p_district: path.district ?? null,
        p_ward: path.ward ?? null,
        p_agent_id: path.agentId ?? null,
        p_funded_since: window.fundedSince ?? null,
        p_funded_until: window.fundedUntil ?? null,
        p_district_id: path.districtId ?? null,
        p_subcounty_id: path.subcountyId ?? null,
      });
      if (error) throw error;
      return (data ?? []) as TenantBreakdownRow[];
    },
  });
}

export interface TenantLeaf {
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  tenant_avatar_url: string | null;
  tenant_photo_url: string | null;
  house_image_urls: string[] | null;
  house_category: string | null;
  rent_amount: number | null;
  rent_request_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  country: string;
  region: string;
  district: string;
  ward: string;
  landlord_funded_at: string | null;
  landlord_funded_amount: number | null;
  landlord_payout_count: number | null;
  outstanding_status: 'paid_up' | 'partial' | 'overdue' | 'defaulted' | null;
  verification_status: 'verified' | 'pending' | 'missing' | null;
  funding_source: 'supporter' | 'platform' | null;
}

export function useTenantsAtLeaf(
  path: TenantBreadcrumbPath,
  window: TenantFundedWindow = {},
  extras: {
    outstanding?: 'paid_up' | 'partial' | 'overdue' | 'defaulted' | null;
    verification?: 'verified' | 'pending' | 'missing' | null;
    fundingSource?: 'supporter' | 'platform' | null;
  } = {},
) {
  const enabled = tenantNextLevel(path) === 'tenants';
  return useQuery({
    enabled,
    queryKey: [
      'tenants-at-leaf',
      path.country, path.region, path.district, path.ward, path.agentId, path.landlordId,
      window.fundedSince ?? null, window.fundedUntil ?? null,
      extras.outstanding ?? null, extras.verification ?? null, extras.fundingSource ?? null,
    ],
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenants_at_leaf' as any, {
        p_country: path.country!,
        p_region: path.region!,
        p_district: path.district!,
        p_ward: path.ward!,
        p_agent_id: path.agentId ?? null,
        p_landlord_id: path.landlordId ?? null,
        p_limit: 300,
        p_funded_since: window.fundedSince ?? null,
        p_funded_until: window.fundedUntil ?? null,
        p_outstanding: extras.outstanding ?? null,
        p_verification: extras.verification ?? null,
        p_funding_source: extras.fundingSource ?? null,
      });
      if (error) throw error;
      return (data ?? []) as TenantLeaf[];
    },
  });
}