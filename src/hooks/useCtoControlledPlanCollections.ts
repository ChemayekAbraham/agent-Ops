import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  toPlan,
  toSearchRow,
  toSummary,
  type CtoControlledPlan,
  type CtoControlledSummary,
  type CtoPlanSearchRow,
} from '@/lib/ctoControlledPlans';

const anyDb = supabase as any;

export const CTO_CONTROLLED_PLANS_KEY = ['cto-controlled-plan-collections'] as const;

export interface CtoControlledPlansData {
  plans: CtoControlledPlan[];
  summary: CtoControlledSummary;
}

async function fetchCollections(): Promise<CtoControlledPlansData> {
  const { data, error } = await anyDb.rpc('get_cto_controlled_plan_collections');
  if (error) throw error;
  const rows = (data ?? []) as Record<string, any>[];
  return {
    plans: rows.filter((r) => r.row_kind === 'plan').map(toPlan),
    summary: toSummary(rows.find((r) => r.row_kind === 'summary')),
  };
}

/**
 * Collections per CTO-controlled Rent Plan (`get_cto_controlled_plan_collections`). Balances and totals must never be stale, so nothing is
 * cached: always fresh on mount, refetched every 30 seconds and whenever the window regains focus.
 */
export function useCtoControlledPlanCollections() {
  return useQuery({
    queryKey: CTO_CONTROLLED_PLANS_KEY,
    queryFn: fetchCollections,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    refetchOnMount: 'always',
    retry: 1,
  });
}

/** Plan search for the "Manage CTO plans" dialog (`cto_search_rent_plans`): tenant name, phone or agent name, two characters or more. */
export function useCtoPlanSearch(term: string, enabled: boolean) {
  const t = term.trim();
  return useQuery({
    queryKey: ['cto-plan-search', t],
    enabled: enabled && t.length >= 2,
    staleTime: 0,
    gcTime: 0,
    queryFn: async (): Promise<CtoPlanSearchRow[]> => {
      const { data, error } = await anyDb.rpc('cto_search_rent_plans', { p_term: t, p_limit: 25 });
      if (error) throw error;
      return ((data ?? []) as Record<string, any>[]).map(toSearchRow);
    },
  });
}

/** Add / remove plans. All writes go through the two RPCs; the frontend never touches the table or the ledger. */
export function useCtoControlledPlanMutations() {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: CTO_CONTROLLED_PLANS_KEY });
    qc.invalidateQueries({ queryKey: ['cto-plan-search'] });
  };
  const add = useMutation({
    mutationFn: async (ids: string[]): Promise<number> => {
      const { data, error } = await anyDb.rpc('cto_add_controlled_plans', { p_rent_request_ids: ids });
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (ids: string[]): Promise<number> => {
      const { data, error } = await anyDb.rpc('cto_remove_controlled_plans', { p_rent_request_ids: ids });
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: refresh,
  });
  return { add, remove };
}
