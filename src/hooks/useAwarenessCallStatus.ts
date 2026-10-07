import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  chunkIds, idsFingerprint, uniqueSortedIds, type AwarenessCallStatus,
} from '@/lib/awarenessCallStatus';

/**
 * Whether each Rent Plan on a list has an awareness call, in one batched read for the whole list (not one per card).
 * Read-only: it never blocks or confirms anything. If the read fails or the person is not allowed to use it, no badges
 * are shown and the list works as before. A list longer than 200 Rent Plans is read in chunks of 200 inside the same query.
 */
const anyDb = supabase as any;

export const awarenessCallStatusKey = ['awareness-call-status'] as const;

export function useAwarenessCallStatus(requestIds: (string | null | undefined)[], enabled = true) {
  const ids = useMemo(() => uniqueSortedIds(requestIds), [requestIds]);
  const fingerprint = idsFingerprint(ids);

  const query = useQuery({
    queryKey: [...awarenessCallStatusKey, fingerprint],
    enabled: enabled && ids.length > 0,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<AwarenessCallStatus[]> => {
      const parts = await Promise.all(chunkIds(ids).map(async (chunk) => {
        const { data, error } = await anyDb.rpc('awareness_call_status_for_requests', { p_request_ids: chunk });
        if (error) throw error;
        return (data ?? []) as AwarenessCallStatus[];
      }));
      return parts.flat();
    },
  });

  const byId = useMemo(() => {
    const map = new Map<string, AwarenessCallStatus>();
    for (const row of query.data ?? []) map.set(row.rent_request_id, row);
    return map;
  }, [query.data]);

  return { byId, isLoading: query.isLoading, isError: query.isError, loaded: query.data !== undefined && !query.isError };
}
