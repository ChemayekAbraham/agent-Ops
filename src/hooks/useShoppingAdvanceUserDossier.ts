import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DossierRecord = Record<string, unknown>;

export interface ShoppingAdvanceDossier {
  profile: DossierRecord | null;
  qualification: DossierRecord;
  wallet: DossierRecord;
  rent_plans: DossierRecord[];
  agent_advances: DossierRecord[];
  advance_requests: DossierRecord[];
  business_advances: DossierRecord[];
  obligations: DossierRecord[];
  portfolios: DossierRecord[];
  shares: DossierRecord[];
  ai_id: string;
  trust_profile: DossierRecord | null;
}

export function useShoppingAdvanceUserDossier(userId: string | null) {
  return useQuery({
    queryKey: ['agent-ops-shopping-advance-user-dossier', userId],
    enabled: Boolean(userId),
    staleTime: 60_000,
    queryFn: async () => {
      if (!userId) throw new Error('No user selected');
      const { data, error } = await supabase.rpc('agent_ops_shopping_advance_user_dossier', {
        p_user_id: userId,
      });
      if (error) throw error;
      return data as unknown as ShoppingAdvanceDossier;
    },
  });
}
