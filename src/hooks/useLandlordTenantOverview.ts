import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { LandlordTenantRow } from '@/lib/landlordTenants';

/**
 * Read-only: one landlord's Rent Plans through landlord_tenant_overview (Landlord Ops, COO, CFO, CEO, super admin).
 * The server decides the rows, the money and the funding stage; the browser only shows them.
 */
export function useLandlordTenantOverview(landlordId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['landlord-tenant-overview', landlordId],
    enabled: enabled && !!landlordId,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<LandlordTenantRow[]> => {
      const { data, error } = await supabase.rpc('landlord_tenant_overview', { p_landlord_id: landlordId as string });
      if (error) throw error;
      return ((data ?? []) as unknown as LandlordTenantRow[]).map((r) => ({
        ...r,
        rent_amount: Number(r.rent_amount) || 0,
        daily_repayment: Number(r.daily_repayment) || 0,
        total_repayment: Number(r.total_repayment) || 0,
        amount_repaid: Number(r.amount_repaid) || 0,
        balance_left: Number(r.balance_left) || 0,
      }));
    },
  });
}
