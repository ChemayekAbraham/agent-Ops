/** Reads tops_blocked_items() — funded/landlord-unpaid, approved/unfunded, agents below adequacy. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface BlockedGroup<T> {
  count: number;
  items: T[];
  items_capped_at?: number;
}

export interface BlockedItems {
  funded_landlord_unpaid: BlockedGroup<{ rent_request_id: string; tenant_name: string | null; funded_at: string }>;
  approved_unfunded: BlockedGroup<{ rent_request_id: string; tenant_name: string | null; approved_at: string }>;
  agents_below_adequacy: BlockedGroup<{ agent_id: string; agent_name: string | null; best_pct: number }>;
}

async function fetchBlockedItems(): Promise<BlockedItems> {
  const { data, error } = await anyDb.rpc('tops_blocked_items');
  if (error) throw error;
  return data as BlockedItems;
}

export function useBlockedItems() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'blockedItems'],
    queryFn: fetchBlockedItems,
    staleTime: 60_000,
  });
}
