import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Fixed one-off setup bonus paid to an agent for a verified Service Centre. */
export const SERVICE_CENTRE_BONUS = 25000;

export type ServiceCentreStatus = 'pending' | 'verified' | 'active' | 'approved' | 'paid' | 'rejected';

export interface ServiceCentre {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  photo_url: string;
  latitude: number;
  longitude: number;
  location_name: string | null;
  status: ServiceCentreStatus;
  verified_by: string | null;
  verified_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

/**
 * Single source of truth for every Service Centre record.
 * All Agent Ops service-centre views read from this one query so the
 * overview, directory and payout screens can never disagree.
 */
export function useServiceCentres() {
  return useQuery({
    queryKey: ['service-centres-all'],
    queryFn: async (): Promise<ServiceCentre[]> => {
      const rows: any[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('service_centre_setups' as any)
          .select('*')
          .order('created_at', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }
      return rows.map((r) => ({
        ...r,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        status: (r.status || 'pending') as ServiceCentreStatus,
      })) as ServiceCentre[];
    },
    staleTime: 30_000,
  });
}

export const SC_STATUS_META: Record<ServiceCentreStatus, { label: string; className: string; dot: string }> = {
  pending:  { label: 'Awaiting verification', className: 'bg-amber-500/15 text-amber-600',   dot: 'hsl(38 92% 50%)' },
  verified: { label: 'Verified — awaiting payout', className: 'bg-blue-500/15 text-blue-600', dot: 'hsl(217 91% 60%)' },
  active:   { label: 'Active', className: 'bg-emerald-500/15 text-emerald-600', dot: 'hsl(160 84% 39%)' },
  approved: { label: 'Approved',               className: 'bg-emerald-500/15 text-emerald-600', dot: 'hsl(160 84% 39%)' },
  paid:     { label: 'Live & paid',            className: 'bg-emerald-600/15 text-emerald-700', dot: 'hsl(142 71% 45%)' },
  rejected: { label: 'Rejected',               className: 'bg-destructive/15 text-destructive', dot: 'hsl(0 84% 60%)' },
};

export const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
