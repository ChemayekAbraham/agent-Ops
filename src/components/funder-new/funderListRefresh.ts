import { useEffect, useSyncExternalStore } from 'react';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { BoardItems } from '@/lib/fundersBoard';
import type { FunderNewEmptyHouse, FunderNewListResult, FunderNewReadyPlan } from './types';

/**
 * Keeping the funders' houses list honest after money moves (bug 16 Nov, ref
 * F51F93B1: a funded tenant stayed "Verified" with "Fund this House").
 *
 * The server is the truth: a request leaves partner_self_list_fundable_plans
 * the moment it is funded or claimed. The app's queries are cached (10 min by
 * default, no refetch on focus), so after a fund we
 *   1. drop the card from the cached lists at once (dropFundedFromCache),
 *   2. remember what this funder booked in this session (markBookedByMe), so
 *      their own shows "Booked — waiting for landlord payment", and
 *   3. refetch the lists, the map clusters and the counts (refreshFunderLists).
 * useFunderListsAutoRefresh also refetches every 60 s while the page is open
 * and visible, and when the app comes back to the foreground.
 */

/** Every read behind the funders' list, its map and its counts. */
export const FUNDER_LIST_QUERY_KEYS = [
  ['funder-new'], // fundable plans, empty houses, funders board items, market summary
  ['psm-fundable-plans'],
  ['empty-house-map-cells'],
  ['empty-house-map-cells-near'],
] as const;

export function refreshFunderLists(queryClient: QueryClient): Promise<unknown> {
  return Promise.all(FUNDER_LIST_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] })));
}

/** What the funder sees for their own just-funded Rent Plan. */
export const BOOKED_BY_ME_TEXT = 'Booked — waiting for landlord payment';

/** Rent request states that can never be funded again. */
const FUNDED_STATES = new Set(['funded', 'repaying', 'completed']);

/**
 * True when a plan from ANY source says it is already funded or claimed: a
 * funded / repaying / completed status, or a confirmed claim. The fundable
 * plans read never returns these; this guards stale or other lists.
 */
export function isFundedOrClaimed(plan: unknown): boolean {
  if (!plan || typeof plan !== 'object') return false;
  const p = plan as Record<string, unknown>;
  const status = typeof p.status === 'string' ? p.status.toLowerCase() : '';
  const claim = typeof p.claim_status === 'string' ? p.claim_status.toLowerCase() : '';
  return FUNDED_STATES.has(status) || claim === 'confirmed' || p.has_confirmed_claim === true;
}

/* ───────────── what this funder booked in this session ───────────── */

const STORE_KEY = 'welile.funder.bookedByMe';
let bookedByMe: ReadonlySet<string> = readStored();
const listeners = new Set<() => void>();

function readStored(): ReadonlySet<string> {
  try {
    const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(STORE_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function markBookedByMe(ids: string[]): void {
  if (ids.length === 0) return;
  bookedByMe = new Set([...bookedByMe, ...ids]);
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify([...bookedByMe]));
  } catch {
    /* private mode: the session copy in memory is enough */
  }
  listeners.forEach((fn) => fn());
}

export function unmarkBookedByMe(ids: string[]): void {
  if (!ids.some((id) => bookedByMe.has(id))) return;
  bookedByMe = new Set([...bookedByMe].filter((id) => !ids.includes(id)));
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify([...bookedByMe]));
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

export function getBookedByMe(): ReadonlySet<string> {
  return bookedByMe;
}

/** Test helper. */
export function resetBookedByMe(): void {
  bookedByMe = new Set();
  try {
    window.sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

export function useBookedByMe(): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getBookedByMe,
    getBookedByMe,
  );
}

/* ───────────── drop a funded card from the cached lists ───────────── */

type Pages<T> = InfiniteData<FunderNewListResult<T>>;

function dropFromPages<T>(data: Pages<T> | undefined, ids: Set<string>, idOf: (item: T) => string): Pages<T> | undefined {
  if (!data?.pages) return data;
  let removed = 0;
  const pages = data.pages.map((page) => {
    const items = page.items.filter((item) => {
      const gone = ids.has(idOf(item));
      if (gone) removed += 1;
      return !gone;
    });
    return items.length === page.items.length ? page : { ...page, items };
  });
  if (removed === 0) return data;
  return { ...data, pages: pages.map((page, i) => (i === 0 ? { ...page, total: Math.max(0, page.total - removed) } : page)) };
}

/**
 * Takes the funded cards off the cached lists right away (before the refetch
 * lands): fundable Rent Plans or empty houses, and moves a Rent Plan from
 * Verified to Booked on the cached funders board, with its counts.
 */
export function dropFundedFromCache(queryClient: QueryClient, category: 'ready' | 'empty', ids: string[]): void {
  const gone = new Set(ids);
  if (gone.size === 0) return;
  if (category === 'ready') {
    queryClient.setQueriesData<Pages<FunderNewReadyPlan>>({ queryKey: ['funder-new', 'ready-plans'] }, (data) =>
      dropFromPages(data, gone, (plan) => plan.rent_request_id),
    );
    queryClient.setQueriesData<BoardItems>({ queryKey: ['funder-new', 'board-items'] }, (data) => {
      if (!data) return data;
      let moved = 0;
      let movedUgx = 0;
      const items = data.items.map((item) => {
        if (!gone.has(item.id) || item.tag !== 'verified') return item;
        moved += 1;
        movedUgx += item.rentAmount;
        return { ...item, tag: 'booked' as const, selectable: false, held: false, incomplete: null };
      });
      if (moved === 0) return data;
      const c = data.counts;
      return {
        items,
        counts: {
          ...c,
          verified: Math.max(0, c.verified - moved),
          verified_ugx: Math.max(0, c.verified_ugx - movedUgx),
          booked: c.booked + moved,
          ready_total: Math.max(0, c.ready_total - moved),
          ready_total_ugx: Math.max(0, c.ready_total_ugx - movedUgx),
        },
      };
    });
  } else {
    queryClient.setQueriesData<Pages<FunderNewEmptyHouse>>({ queryKey: ['funder-new', 'empty-houses'] }, (data) =>
      dropFromPages(data, gone, (house) => house.house_id),
    );
  }
}

/** After a successful fund (through Welile, or "I'll pay the landlord myself"). */
export function afterFunded(queryClient: QueryClient, category: 'ready' | 'empty', ids: string[]): Promise<unknown> {
  dropFundedFromCache(queryClient, category, ids);
  if (category === 'ready') markBookedByMe(ids);
  return refreshFunderLists(queryClient);
}

/* ───────────── keep it fresh while open ───────────── */

export const FUNDER_LIST_REFRESH_MS = 60_000;

/**
 * Refetch the funders' lists every 60 s while the page is visible, and as soon
 * as the app returns to the foreground (tab shown again, app resumed, page
 * restored from the back/forward cache).
 */
export function useFunderListsAutoRefresh(queryClient: QueryClient, enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const visible = () => document.visibilityState !== 'hidden';
    const refresh = () => {
      if (visible()) void refreshFunderLists(queryClient);
    };
    const timer = window.setInterval(refresh, FUNDER_LIST_REFRESH_MS);
    const onVisibility = () => {
      if (visible()) refresh();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [queryClient, enabled]);
}
