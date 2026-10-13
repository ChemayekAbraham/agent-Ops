/**
 * Reads tops_landlord_not_paid_summary_amclock(): how many live Rent Plans have no counted landlord
 * payout yet. Those plans owe nothing, have no repayment clock, and are left out of every arrears and
 * due total on the Workspace. Read-only; no arithmetic in the client.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface LandlordNotPaidSummary {
  tenant_paying_no_landlord: number;
  awaiting_landlord: number;
  total_plans: number;
  as_of: string;
}

export function useLandlordNotPaid() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'landlordNotPaid'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<LandlordNotPaidSummary> => {
      const { data, error } = await anyDb.rpc('tops_landlord_not_paid_summary_amclock');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row as LandlordNotPaidSummary;
    },
  });
}
