import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * May the signed-in person see the "Actual Money" figures (MTN and Airtel line balances, cash at hand)?
 *
 * A person can be restricted from the CTO platform (Dashboard Permissions, key `financial-ops-float-hidden`). This hook only
 * decides whether the screen draws the figures. The real lock is in the database: get_cash_at_hand_total and
 * get_phone_platform_reconciliation refuse a restricted caller (migration 20261109140000).
 *
 * While the answer is loading the figures stay hidden, so a restricted person never sees a flash of them. If the database
 * update is not applied yet (the function does not exist) nobody is restricted, so the figures show as before.
 */
export function useCanViewActualFloat(): { canView: boolean; loading: boolean } {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['finops-can-view-actual-float'],
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const call = supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
      const res = await call('can_view_actual_float');
      if (res.error) throw res.error;
      return res.data === true;
    },
  });
  const missing =
    isError && /could not find the function|does not exist|schema cache/i.test((error as { message?: string } | null)?.message ?? '');
  return { canView: data === true || missing, loading: isLoading };
}
