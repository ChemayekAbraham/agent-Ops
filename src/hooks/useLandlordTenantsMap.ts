import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Batched, read-only map of landlord_id -> that landlord's tenants
 * (name + phone), for surfaces that list many landlords at once — e.g. the
 * Landlord Ops verification queue and geographic browser, where per-landlord
 * `useLandlordTenants` would fire one query per row.
 *
 * Reads existing `rent_requests` + `profiles` rows only — no writes, no
 * changes to rent or status logic. Only tenants with a recorded phone are
 * returned, deduped by tenant, capped per landlord.
 */

export interface TenantContact {
  tenant_id: string;
  name: string;
  phone: string;
}

export type LandlordTenantsMap = Record<string, TenantContact[]>;

const MAX_LANDLORDS = 200; // keep the .in() lists and result set bounded
const CHUNK = 100;
const MAX_TENANTS_PER_LANDLORD = 4;

export function useLandlordTenantsMap(landlordIds: string[]) {
  const ids = Array.from(new Set(landlordIds.filter(Boolean))).slice(0, MAX_LANDLORDS);
  const key = ids.slice().sort().join(',');

  return useQuery({
    queryKey: ['landlord-tenants-map', key],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<LandlordTenantsMap> => {
      // Chunk the landlord ids so the .in() filter stays well within limits.
      const rrRows: any[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('rent_requests')
          .select('landlord_id, tenant_id')
          .in('landlord_id', slice)
          .not('tenant_id', 'is', null)
          .limit(1000);
        if (error) throw error;
        rrRows.push(...((data ?? []) as any[]));
      }
      if (!rrRows.length) return {};

      const tenantIds = Array.from(new Set(rrRows.map((r) => r.tenant_id).filter(Boolean)));
      const profileMap = new Map<string, { full_name: string | null; phone: string | null }>();
      for (let i = 0; i < tenantIds.length; i += CHUNK) {
        const slice = tenantIds.slice(i, i + CHUNK);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', slice);
        (profiles ?? []).forEach((p: any) =>
          profileMap.set(p.id, { full_name: p.full_name, phone: p.phone }),
        );
      }

      const out: LandlordTenantsMap = {};
      const seen = new Set<string>();
      for (const r of rrRows) {
        if (!r.landlord_id || !r.tenant_id) continue;
        const pairKey = `${r.landlord_id}:${r.tenant_id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const p = profileMap.get(r.tenant_id);
        const phone = (p?.phone || '').trim();
        if (!phone) continue; // only tenants we can actually call
        const list = (out[r.landlord_id] ||= []);
        if (list.length >= MAX_TENANTS_PER_LANDLORD) continue;
        list.push({
          tenant_id: r.tenant_id,
          name: p?.full_name?.trim() || 'Unnamed tenant',
          phone,
        });
      }
      return out;
    },
  });
}
