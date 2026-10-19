import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  TIMING_BATCH_LIMIT,
  normalizeTiming,
  normalizeTimingBatch,
  timingIdsKey,
  type RentTiming,
  type RentTimingBatch,
} from '@/lib/rentTiming';

/**
 * Rent Plan application timing for the requests a desk has ALREADY loaded: one call for the whole batch (rent_request_timing), never one per card.
 * The server decides every figure and returns one as_of for the batch, so every surface that shows the same request at the same as_of shows the same
 * values. Read-only; no polling (the answer is kept for a minute and refreshed when a desk is opened again). A failure is an error, never a zero;
 * a request the server left out (not visible to the caller) simply has no row and the card shows "Not available".
 *
 * At most TIMING_BATCH_LIMIT (200) ids go in one call; `omitted` says how many were not asked for, so a caller can page instead of losing them silently.
 */
export function useRentRequestTiming(ids: string[], options: { enabled?: boolean } = {}) {
  const unique = useMemo(() => [...new Set(ids.filter(Boolean))], [ids]);
  const asked = useMemo(() => unique.slice(0, TIMING_BATCH_LIMIT), [unique]);
  const key = useMemo(() => timingIdsKey(asked), [asked]);
  const q = useQuery({
    queryKey: ['rent-request-timing', key],
    enabled: (options.enabled ?? true) && asked.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<RentTimingBatch> => {
      const { data, error } = await supabase.rpc('rent_request_timing', { p_request_ids: asked });
      if (error) throw error;
      return normalizeTimingBatch(data);
    },
  });
  const byId = useMemo(() => {
    const m = new Map<string, RentTiming>();
    q.data?.rows.forEach((r) => m.set(r.request_id, r));
    return m;
  }, [q.data]);
  return {
    batch: q.data ?? null,
    byId,
    asOf: q.data?.as_of ?? null,
    /** ids that were not sent because the batch is limited */
    omitted: Math.max(0, unique.length - asked.length),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error ?? null,
    refetch: () => { void q.refetch(); },
  };
}

/** The full visit-by-visit journey of ONE request, loaded only when it is opened (`enabled`). */
export function useRentRequestTimingHistory(requestId: string | null, enabled = false) {
  const q = useQuery({
    queryKey: ['rent-request-timing-history', requestId],
    enabled: enabled && !!requestId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<RentTiming | null> => {
      const { data, error } = await supabase.rpc('rent_request_timing_history', { p_request_id: requestId as string });
      if (error) throw error;
      return data ? normalizeTiming({ ...(data as object) }) : null;
    },
  });
  return {
    data: q.data ?? null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error ?? null,
    refetch: () => { void q.refetch(); },
  };
}
