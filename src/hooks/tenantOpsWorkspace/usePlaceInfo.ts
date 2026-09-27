/**
 * Place block: reads the existing location source(s) — no new geo
 * aggregation. Mirrors the exact hand-join src/components/agent/
 * TenantProfileView.tsx already uses (rent_requests -> landlords /
 * lc1_chairpersons), plus the one existing tenant-level admin-chain view
 * (v_tenant_location_pivot) and a plain house_listings read by id.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface PlaceInfo {
  latitude: number | null;
  longitude: number | null;
  landlord: {
    name: string | null;
    phone: string | null;
    propertyAddress: string | null;
    houseCategory: string | null;
    village: string | null;
    subCounty: string | null;
    district: string | null;
  } | null;
  lc1: {
    name: string | null;
    phone: string | null;
    village: string | null;
    verified: boolean | null;
  } | null;
  house: {
    title: string | null;
    address: string | null;
    region: string | null;
    district: string | null;
    subCounty: string | null;
    village: string | null;
  } | null;
  adminChain: {
    country: string | null;
    region: string | null;
    district: string | null;
    ward: string | null;
  } | null;
}

async function fetchPlaceInfo(rentRequestId: string): Promise<PlaceInfo> {
  const { data: rr, error: rrError } = await anyDb
    .from('rent_requests')
    .select(
      `request_latitude, request_longitude, tenant_id, house_listing_id,
       landlord:landlords(name, property_address, house_category, phone, village, sub_county, district),
       lc1:lc1_chairpersons(name, phone, village, verified)`,
    )
    .eq('id', rentRequestId)
    .maybeSingle();
  if (rrError) throw rrError;

  const [pivotRes, houseRes] = await Promise.all([
    rr?.tenant_id
      ? anyDb
          .from('v_tenant_location_pivot')
          .select('country, region, district, ward')
          .eq('tenant_id', rr.tenant_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    rr?.house_listing_id
      ? anyDb
          .from('house_listings')
          .select('title, address, region, district, sub_county, village')
          .eq('id', rr.house_listing_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    latitude: rr?.request_latitude ?? null,
    longitude: rr?.request_longitude ?? null,
    landlord: rr?.landlord
      ? {
          name: rr.landlord.name ?? null,
          phone: rr.landlord.phone ?? null,
          propertyAddress: rr.landlord.property_address ?? null,
          houseCategory: rr.landlord.house_category ?? null,
          village: rr.landlord.village ?? null,
          subCounty: rr.landlord.sub_county ?? null,
          district: rr.landlord.district ?? null,
        }
      : null,
    lc1: rr?.lc1
      ? {
          name: rr.lc1.name ?? null,
          phone: rr.lc1.phone ?? null,
          village: rr.lc1.village ?? null,
          verified: rr.lc1.verified ?? null,
        }
      : null,
    house: houseRes.data
      ? {
          title: houseRes.data.title ?? null,
          address: houseRes.data.address ?? null,
          region: houseRes.data.region ?? null,
          district: houseRes.data.district ?? null,
          subCounty: houseRes.data.sub_county ?? null,
          village: houseRes.data.village ?? null,
        }
      : null,
    adminChain: pivotRes.data
      ? {
          country: pivotRes.data.country ?? null,
          region: pivotRes.data.region ?? null,
          district: pivotRes.data.district ?? null,
          ward: pivotRes.data.ward ?? null,
        }
      : null,
  };
}

export function usePlaceInfo(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'placeInfo', rentRequestId],
    queryFn: () => fetchPlaceInfo(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
