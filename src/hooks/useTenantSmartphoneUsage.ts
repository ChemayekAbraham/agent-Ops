/**
 * Smartphone usage for the Tenant Classification tab (Tenant Operations Workspace).
 *
 * Data-fetching only: one read-only SECURITY DEFINER RPC, `tops_smartphone_usage(p_from, p_to)`,
 * staff-gated by `_am_staff_ok()`. `fromDay` / `toDay` are Kampala calendar days (YYYY-MM-DD) — the
 * server compares Kampala dates, so the client never works out a day boundary or a count itself.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TenantSmartphoneUsage } from '@/lib/tenantSmartphoneUsage';

const anyDb = supabase as any;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The window figures plus the all-time recorded/confirmed split, in one call. */
export function useTenantSmartphoneUsage(fromDay: string, toDay: string) {
  return useQuery({
    queryKey: ['tenant-smartphone-usage', fromDay, toDay],
    staleTime: 120_000,
    enabled: DAY.test(fromDay) && DAY.test(toDay),
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<TenantSmartphoneUsage> => {
      const { data, error } = await anyDb.rpc('tops_smartphone_usage', { p_from: fromDay, p_to: toDay });
      if (error) throw new Error(error.message);
      return data as TenantSmartphoneUsage;
    },
  });
}
