import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { AppRole } from '@/hooks/useAuth';
import {
  AuthRequiredError,
  hasUsableUserSession,
  isUnauthenticatedRpcError,
  useAuthenticatedAudience,
} from '@/hooks/useAuthenticatedPoll';
import {
  toPlan,
  toSearchRow,
  toSummary,
  type CtoControlledPlan,
  type CtoControlledSummary,
  type CtoPlanSearchRow,
} from '@/lib/ctoControlledPlans';

const anyDb = supabase as any;

/**
 * `get_cto_controlled_plan_collections` allows cto, ceo and cfo. super_admin can
 * open the CTO dashboard, so the panel keeps calling for that role too. The
 * function still rejects anyone else. EXECUTE is not granted to anon.
 */
const CTO_COLLECTION_ROLES: readonly AppRole[] = ['cto', 'ceo', 'cfo', 'super_admin'];

async function assertUserSession(): Promise<void> {
  if (!(await hasUsableUserSession())) throw new AuthRequiredError();
}

export const CTO_CONTROLLED_PLANS_KEY = ['cto-controlled-plan-collections'] as const;

export interface CtoControlledPlansData {
  plans: CtoControlledPlan[];
  summary: CtoControlledSummary;
}

async function fetchCollections(): Promise<CtoControlledPlansData> {
  await assertUserSession();
  const { data, error } = await anyDb.rpc('get_cto_controlled_plan_collections');
  if (isUnauthenticatedRpcError(error)) throw new AuthRequiredError(error.message);
  if (error) throw error;
  const rows = (data ?? []) as Record<string, any>[];
  return {
    plans: rows.filter((r) => r.row_kind === 'plan').map(toPlan),
    summary: toSummary(rows.find((r) => r.row_kind === 'summary')),
  };
}

/**
 * Collections per CTO-controlled Rent Plan (`get_cto_controlled_plan_collections`). Balances and totals must never be stale, so nothing is
 * cached: always fresh on mount, refetched every 10 seconds and whenever the window regains focus.
 * The query stays off until a signed-in CTO, CEO, CFO or super_admin session is ready, and a 401
 * (missing or expired user JWT) stops the interval instead of retrying as the anon role.
 */
export function useCtoControlledPlanCollections() {
  const allowed = useAuthenticatedAudience(CTO_COLLECTION_ROLES);
  return useQuery({
    queryKey: CTO_CONTROLLED_PLANS_KEY,
    queryFn: fetchCollections,
    enabled: allowed,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => (
      allowed && !isUnauthenticatedRpcError(query.state.error) ? 10_000 : false
    ),
    refetchOnWindowFocus: allowed ? 'always' : false,
    refetchOnMount: 'always',
    retry: (failureCount, error) => failureCount < 1 && !isUnauthenticatedRpcError(error),
  });
}

/** Plan search for the "Manage CTO plans" dialog (`cto_search_rent_plans`): tenant name, phone or agent name, two characters or more. */
export function useCtoPlanSearch(term: string, enabled: boolean) {
  const allowed = useAuthenticatedAudience(CTO_COLLECTION_ROLES);
  const t = term.trim();
  return useQuery({
    queryKey: ['cto-plan-search', t],
    enabled: enabled && allowed && t.length >= 2,
    staleTime: 0,
    gcTime: 0,
    retry: (failureCount, error) => failureCount < 1 && !isUnauthenticatedRpcError(error),
    queryFn: async (): Promise<CtoPlanSearchRow[]> => {
      await assertUserSession();
      const { data, error } = await anyDb.rpc('cto_search_rent_plans', { p_term: t, p_limit: 25 });
      if (isUnauthenticatedRpcError(error)) throw new AuthRequiredError(error.message);
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
      await assertUserSession();
      const { data, error } = await anyDb.rpc('cto_add_controlled_plans', { p_rent_request_ids: ids });
      if (isUnauthenticatedRpcError(error)) throw new AuthRequiredError(error.message);
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (ids: string[]): Promise<number> => {
      await assertUserSession();
      const { data, error } = await anyDb.rpc('cto_remove_controlled_plans', { p_rent_request_ids: ids });
      if (isUnauthenticatedRpcError(error)) throw new AuthRequiredError(error.message);
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: refresh,
  });
  return { add, remove };
}
