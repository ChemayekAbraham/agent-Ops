import { supabase } from '@/integrations/supabase/client';
import { requireUserSession } from '@/hooks/useAuthenticatedPoll';
import type { FunderSavedState } from '@/lib/funderSavedItems';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';

export type SavedFunderEntry = { category: FunderNewCategory; item: FunderNewEmptyHouse | FunderNewReadyPlan };

/** Use the existing authorized opportunity services, never a filtered feed or a new access path. */
export async function loadFunderSavedItems(saved: FunderSavedState, signal: AbortSignal): Promise<SavedFunderEntry[]> {
  await requireUserSession();
  const readCategory = async (category: FunderNewCategory): Promise<SavedFunderEntry[]> => {
    const wanted = new Set(saved[category]);
    if (wanted.size === 0) return [];
    const found = new Map<string, SavedFunderEntry>();
    for (let offset = 0; ; offset += 100) {
      signal.throwIfAborted();
      const request = category === 'empty'
        ? supabase.rpc('agent_list_empty_house_opportunities', { p_limit: 100, p_offset: offset, p_verified_only: true, p_sort: 'newest' })
        : supabase.rpc('partner_self_list_fundable_plans', { p_limit: 100, p_offset: offset });
      const { data, error } = await request.abortSignal(signal);
      if (error) throw error;
      const payload = data as unknown as Record<string, unknown> | null;
      const rows = payload?.[category === 'empty' ? 'houses' : 'plans'];
      if (!Array.isArray(rows)) throw new Error('Availability response was incomplete');
      for (const row of rows) {
        const item = row as FunderNewEmptyHouse | FunderNewReadyPlan;
        const id = category === 'empty' ? (item as FunderNewEmptyHouse).house_id : (item as FunderNewReadyPlan).rent_request_id;
        if (wanted.has(id)) found.set(id, { category, item });
      }
      if (rows.length < 100 || found.size === wanted.size) return [...found.values()];
    }
  };
  const [empty, ready] = await Promise.all([readCategory('empty'), readCategory('ready')]);
  return [...empty, ...ready];
}