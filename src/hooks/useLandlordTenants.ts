import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Read-only list of the tenants attached to one landlord, for the Landlord
 * Calling Hub drawer. Reads existing `rent_requests` + `profiles` rows only —
 * no new state, no writes, no changes to rent or status logic.
 */

export interface LandlordTenantRow {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  status: string;
  rent_amount: number;
  daily_repayment: number;
  amount_repaid: number;
  total_repayment: number;
  outstanding: number;
  created_at: string | null;
}

export function useLandlordTenants(landlordId: string | null) {
  return useQuery({
    queryKey: ['landlord-drawer-tenants', landlordId],
    enabled: !!landlordId,
    staleTime: 60_000,
    queryFn: async (): Promise<LandlordTenantRow[]> => {
      const { data: rrs, error } = await supabase
        .from('rent_requests')
        .select(
          'id, tenant_id, status, rent_amount, daily_repayment, amount_repaid, total_repayment, created_at',
        )
        .eq('landlord_id', landlordId!)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = (rrs ?? []) as any[];
      if (!rows.length) return [];

      const ids = Array.from(new Set(rows.map(r => r.tenant_id).filter(Boolean)));
      const profileMap = new Map<string, { full_name: string | null; phone: string | null }>();
      if (ids.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        (profiles ?? []).forEach((p: any) => profileMap.set(p.id, { full_name: p.full_name, phone: p.phone }));
      }

      return rows.map(r => {
        const p = profileMap.get(r.tenant_id);
        const total = Number(r.total_repayment) || 0;
        const repaid = Number(r.amount_repaid) || 0;
        return {
          rent_request_id: r.id,
          tenant_id: r.tenant_id,
          tenant_name: p?.full_name || 'Unnamed tenant',
          tenant_phone: p?.phone || '',
          status: r.status || '',
          rent_amount: Number(r.rent_amount) || 0,
          daily_repayment: Number(r.daily_repayment) || 0,
          amount_repaid: repaid,
          total_repayment: total,
          outstanding: Math.max(0, total - repaid),
          created_at: r.created_at ?? null,
        };
      });
    },
  });
}
