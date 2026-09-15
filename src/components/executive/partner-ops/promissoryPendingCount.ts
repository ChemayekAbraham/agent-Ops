import type { QueryClient } from '@tanstack/react-query';

/**
 * Shared cache key + optimistic-update helpers for the Promissory Notes
 * pending-count badge shown in the Partner Ops header button.
 *
 * Pattern: bump() the cached count the moment a mutation starts, roll it back
 * if the mutation fails, and reconcile() on success so the value settles on
 * the real database count (also delivered by the realtime broadcast).
 */
export const PROMISSORY_PENDING_COUNT_KEY = ['promissory-notes-pending-count'] as const;

/** Optimistically adjust the pending badge. Never lets the count go below 0. */
export function bumpPromissoryPendingCount(queryClient: QueryClient, delta: number) {
  queryClient.setQueryData<number>([...PROMISSORY_PENDING_COUNT_KEY], (old) =>
    Math.max(0, (old ?? 0) + delta),
  );
}

/** Pull the true count back from the database (runs alongside realtime). */
export function reconcilePromissoryPendingCount(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: [...PROMISSORY_PENDING_COUNT_KEY] });
}
