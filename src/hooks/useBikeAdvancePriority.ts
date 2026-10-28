import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface BikeAdvancePriority {
  day: string;
  protected: boolean;
  applicable: boolean;
  bike_daily: number;
  bike_paid_today: number;
  bike_remaining_today: number;
  advance_outstanding: number;
  advance_from_surplus: boolean;
}

export function useBikeAdvancePriority(agentId?: string | null, enabled = true) {
  return useQuery<BikeAdvancePriority>({
    queryKey: ['bike-advance-priority', agentId],
    enabled: enabled && !!agentId,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      if (!agentId) throw new Error('Agent unavailable');
      const { data, error } = await supabase.rpc('agent_bike_advance_priority', { p_agent_id: agentId });
      if (error) throw error;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Recovery order unavailable');
      return data as unknown as BikeAdvancePriority;
    },
  });
}