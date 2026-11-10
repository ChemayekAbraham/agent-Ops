import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * May the signed-in person see the "Actual Money" figures (MTN and Airtel line balances, cash at hand)?
 *
 * A person can be restricted from the CTO platform (Dashboard Permissions, key `financial-ops-float-hidden`). This hook only
 * decides whether the screen draws the figures. The real lock is in the database: get_cash_at_hand_total and
 * get_phone_platform_reconciliation refuse a restricted caller (migration 20261109140000).
 *
 * FAIL OPEN: the figures are hidden only when the server explicitly says this person is restricted (answer === false).
 * Any other outcome (still loading, the function missing because migration 20261109140000 is not applied, a network or
 * permission error) shows the figures as before. Hiding on every error hid the figures from everyone.
 */
export function useCanViewActualFloat(): { canView: boolean; loading: boolean } {
  const { data, isLoading } = useQuery({
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
  return { canView: data !== false, loading: isLoading };
}
