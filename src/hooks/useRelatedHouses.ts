import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import { haversineKm } from '@/lib/houseGeo';

const MONTHLY_ROI_RATE = 15;
const LIMIT = 5;
const FETCH_MORE = LIMIT * 3;

function hasLocation(h: HouseOpportunity | null): boolean {
  if (!h) return false;
  return !!h.district?.trim();
}


function hasGps(h: HouseOpportunity | null): boolean {
  if (!h) return false;
  const lat = Number(h.latitude);
  const lng = Number(h.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
}

function distanceBetween(a: HouseOpportunity, b: HouseOpportunity): number | null {
  if (!hasGps(a) || !hasGps(b)) return null;
  return haversineKm(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude));
}

/**
 * Fetches up to 5 empty houses in the same location as the current house.
 *
 * Ranking prefers the most specific location match (village > sub-county > district),
 * then GPS proximity, then the newest listing. Results are safe to render while a
 * Supporter is browsing, because they only include verified, available, unhidden
 * listings with a positive rent.
 */
export function useRelatedHouses(currentHouse: HouseOpportunity | null) {
  return useQuery<HouseOpportunity[]>({
    queryKey: ['related-houses', currentHouse?.house_id],
    enabled: !!currentHouse && hasLocation(currentHouse),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      if (!currentHouse) return [];

      // Same district is the unit of comparison the Supporter sees on the map.
      const district = currentHouse.district?.trim();
      if (!district) return [];


      const { data, error } = await supabase
        .from('house_listings')
        .select(
          `id,
          title,
          house_category,
          number_of_rooms,
          monthly_rent,
          region,
          district,
          sub_county,
          village,
          address,
          latitude,
          longitude,
          image_urls,
          status,
          tenant_id,
          landlord_id,
          verified,
          created_at,
          agent_id`
        )
        .neq('id', currentHouse.house_id)
        .eq('status', 'available')
        .is('tenant_id', null)
        .eq('verified', true)
        .eq('is_hidden', false)
        .gt('monthly_rent', 0)
        .ilike('district', district)
        .order('created_at', { ascending: false })
        .limit(FETCH_MORE);

      if (error) throw error;

      const rows = (data ?? []) as any[];
      const landlordIds = Array.from(new Set(rows.map((r) => r.landlord_id).filter(Boolean)));
      const agentIds = Array.from(new Set(rows.map((r) => r.agent_id).filter(Boolean)));

      const [{ data: landlords }, { data: agents }] = await Promise.all([
        landlordIds.length > 0
          ? supabase.from('landlords').select('id, name, phone').in('id', landlordIds)
          : Promise.resolve({ data: [] as any[], error: null }),
        agentIds.length > 0
          ? supabase.from('profiles').select('id, full_name').in('id', agentIds)
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);

      const landlordById = new Map((landlords ?? []).map((l: any) => [l.id, l]));
      const agentById = new Map((agents ?? []).map((p: any) => [p.id, p]));

      const mapped = rows.map((r): HouseOpportunity => {
        const monthlyRent = Number(r.monthly_rent || 0);
        const monthlyReturn = Math.round((monthlyRent * MONTHLY_ROI_RATE) / 100);
        const landlord = r.landlord_id ? landlordById.get(r.landlord_id) : null;
        const agent = r.agent_id ? agentById.get(r.agent_id) : null;

        const imageUrls = Array.isArray(r.image_urls)
          ? r.image_urls.filter((u: unknown): u is string => typeof u === 'string' && u.trim().length > 0)
          : [];

        const candidate: HouseOpportunity = {
          house_id: String(r.id),
          title: r.title ?? null,
          house_category: r.house_category ?? null,
          monthly_rent: monthlyRent,
          district: r.district ?? null,
          sub_county: r.sub_county ?? null,
          village: r.village ?? null,
          region: r.region ?? null,
          number_of_rooms: r.number_of_rooms ?? null,
          verified: r.verified === true,
          listing_agent_id: r.agent_id ?? null,
          listing_agent_name: agent?.full_name ?? null,
          image_url: imageUrls[0] ?? null,
          image_urls: imageUrls,
          latitude: r.latitude == null ? null : Number(r.latitude),
          longitude: r.longitude == null ? null : Number(r.longitude),
          landlord_id: r.landlord_id ?? null,
          landlord_name: landlord?.name ?? null,
          landlord_phone: landlord?.phone ?? null,
          distance_km: null,
          created_at: r.created_at ?? null,
          partner_monthly_return: monthlyReturn,
          partner_annual_return: monthlyReturn * 12,
        };
        candidate.distance_km = distanceBetween(currentHouse, candidate);
        return candidate;
      });

      const scored = mapped.map((h) => {
        let score = 0;
        if (
          h.village?.trim() &&
          currentHouse.village?.trim() &&
          h.village.toLowerCase() === currentHouse.village.toLowerCase()
        ) {
          score += 30;
        }
        if (
          h.sub_county?.trim() &&
          currentHouse.sub_county?.trim() &&
          h.sub_county.toLowerCase() === currentHouse.sub_county.toLowerCase()
        ) {
          score += 20;
        }
        if (
          h.district?.trim() &&
          currentHouse.district?.trim() &&
          h.district.toLowerCase() === currentHouse.district.toLowerCase()
        ) {
          score += 10;
        }
        return { h, score, distance: h.distance_km ?? Infinity };
      });

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (!Number.isFinite(a.distance) && !Number.isFinite(b.distance)) return 0;
        if (!Number.isFinite(a.distance)) return 1;
        if (!Number.isFinite(b.distance)) return -1;
        return a.distance - b.distance;
      });

      return scored.slice(0, LIMIT).map((s) => s.h);
    },
  });
}
