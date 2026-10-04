import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  cacheProfile,
  cacheWallet,
  cacheNotifications,
  cacheTransactions,
  cacheRentRequests,
  cacheEarnings,
  cacheUserRoles,
} from '@/lib/offlineDataStorage';

const SNAPSHOT_DB = 'welile-snapshot';
const SNAPSHOT_STORE = 'snapshot';
const SNAPSHOT_DB_VERSION = 2; // Bumped for expanded schema
// Two-tier cache TTLs: wallet/profile refresh sooner; non-critical can sit longer.
const CRITICAL_TTL_MS = 60 * 1000;       // 1 minute — wallet/profile
const EXTENDED_TTL_MS = 5 * 60 * 1000;   // 5 minutes — analytics/lists/notifications
// Backwards-compat export for any external imports.
const CACHE_TTL_MS = CRITICAL_TTL_MS;

export interface UserSnapshot {
  userId: string;
  roles: string[];
  fetchedAt: string;
  version?: number;

  // Universal
  profile: any | null;
  wallet: any | null;
  notifications: any[];
  recentTransactions: any[];

  // Referrals
  referrals: any[];
  referralCount: number;

  // Agent
  subAgents: any[];
  pendingSubAgentInvites: any[];
  userInvites: any[];
  linkSignups: any[];
  earningsSummary: any[];
  agentEarnings: any[];

  // Tenant
  landlords: any[];
  rentRequests: any[];
  repayments: any[];

  // Supporter
  supporterReferrals: any[];
  investmentAccount: any | null;
}

type Tier = 'critical' | 'extended' | 'all';

let dbInstance: IDBDatabase | null = null;

function openSnapshotDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (dbInstance) { resolve(dbInstance); return; }
    const req = indexedDB.open(SNAPSHOT_DB, SNAPSHOT_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      // Drop the cached handle when the browser closes it (iOS backgrounding,
      // storage eviction, version upgrade in another tab); otherwise every later
      // call reuses a dead connection and throws "connection is closing".
      db.onversionchange = () => { db.close(); if (dbInstance === db) dbInstance = null; };
      db.onclose = () => { if (dbInstance === db) dbInstance = null; };
      dbInstance = db;
      resolve(db);
    };
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'userId' });
      }
    };
  });
}

// Run fn on a live connection; if the cached one was dead, reopen once and retry.
async function withSnapshotDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  try {
    return await fn(await openSnapshotDB());
  } catch (e) {
    if ((e as DOMException)?.name !== 'InvalidStateError') throw e;
    dbInstance = null;
    return await fn(await openSnapshotDB());
  }
}

async function getCachedSnapshot(userId: string): Promise<{ data: UserSnapshot; cachedAt: number } | null> {
  try {
    return await withSnapshotDb((db) => {
      const req = db.transaction(SNAPSHOT_STORE, 'readonly').objectStore(SNAPSHOT_STORE).get(userId);
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    });
  } catch { return null; }
}

async function setCachedSnapshot(userId: string, data: UserSnapshot): Promise<void> {
  try {
    await withSnapshotDb((db) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
      tx.objectStore(SNAPSHOT_STORE).put({ userId, data, cachedAt: Date.now() });
      return new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    });
  } catch (e) { console.warn('[Snapshot] cache write failed', e); }
}

/**
 * Fan-out snapshot data into the offline data stores so that
 * individual pages (wallet, profile, notifications, etc.) can
 * read from IndexedDB without a separate network call.
 */
async function hydrateOfflineStores(snapshot: UserSnapshot): Promise<void> {
  try {
    const ops: Promise<void>[] = [];

    if (snapshot.profile) {
      ops.push(cacheProfile(snapshot.profile));
    }
    if (snapshot.wallet) {
      ops.push(cacheWallet(snapshot.wallet));
    }
    if (snapshot.notifications?.length) {
      ops.push(cacheNotifications(snapshot.notifications));
    }
    if (snapshot.recentTransactions?.length) {
      ops.push(cacheTransactions(snapshot.recentTransactions));
    }
    if (snapshot.rentRequests?.length) {
      ops.push(cacheRentRequests(snapshot.rentRequests));
    }
    if (snapshot.agentEarnings?.length) {
      ops.push(cacheEarnings(snapshot.userId, snapshot.agentEarnings));
    }
    if (snapshot.roles?.length) {
      ops.push(cacheUserRoles(snapshot.userId, snapshot.roles));
    }

    await Promise.allSettled(ops);
    console.log('[Snapshot] Hydrated offline stores from snapshot');
  } catch (e) {
    console.warn('[Snapshot] Offline hydration failed (non-critical):', e);
  }
}

const emptySnapshot: UserSnapshot = {
  userId: '',
  roles: [],
  fetchedAt: '',
  profile: null,
  wallet: null,
  notifications: [],
  recentTransactions: [],
  referrals: [],
  referralCount: 0,
  subAgents: [],
  pendingSubAgentInvites: [],
  userInvites: [],
  linkSignups: [],
  earningsSummary: [],
  agentEarnings: [],
  landlords: [],
  rentRequests: [],
  repayments: [],
  supporterReferrals: [],
  investmentAccount: null,
};

export function useUserSnapshot(userId: string | undefined) {
  const [snapshot, setSnapshot] = useState<UserSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  // Per-tier ready flags drive progressive UI.
  const [criticalReady, setCriticalReady] = useState(false);
  const [extendedReady, setExtendedReady] = useState(false);
  // Per-tier error state so widgets can show a localised retry.
  const [criticalError, setCriticalError] = useState<string | null>(null);
  const [extendedError, setExtendedError] = useState<string | null>(null);

  const fetchTier = useCallback(async (tier: Tier, force = false) => {
    if (!userId) return;
    if (!navigator.onLine) return; // caller handled cached display
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      // NOTE: `functions.invoke()` URL-encodes the entire first arg, so a
      // querystring like `user-snapshot?tier=critical` resolves to a
      // function literally named that → 404. Pass tier via body instead;
      // the edge function reads either source.
      const res = await supabase.functions.invoke('user-snapshot', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { tier },
      });
      if (res.error) {
        const msg = res.error.message || `Failed to load ${tier} data`;
        if (tier === 'critical') setCriticalError(msg);
        if (tier === 'extended') setExtendedError(msg);
        return;
      }
      const partial = (res.data || {}) as Partial<UserSnapshot>;
      setSnapshot((prev) => {
        const next = { ...prev, ...partial } as UserSnapshot;
        // Persist merged snapshot + fan out to per-domain stores.
        void setCachedSnapshot(userId, next);
        void hydrateOfflineStores(next);
        return next;
      });
      setLastFetched(Date.now());
      if (tier === 'critical' || tier === 'all') {
        setCriticalReady(true);
        setCriticalError(null);
      }
      if (tier === 'extended' || tier === 'all') {
        setExtendedReady(true);
        setExtendedError(null);
      }
    } catch (err) {
      console.error(`[Snapshot] ${tier} fetch failed:`, err);
      const msg = err instanceof Error ? err.message : 'Network error';
      if (tier === 'critical') setCriticalError(msg);
      if (tier === 'extended') setExtendedError(msg);
    }
  }, [userId]);

  const fetchSnapshot = useCallback(async (force = false) => {
    if (!userId) return;

    // Always try to show cached data immediately (stale-while-revalidate)
    const cached = await getCachedSnapshot(userId);
    if (cached) {
      setSnapshot(cached.data);
      setLastFetched(cached.cachedAt);
      setLoading(false);
      // Cached data counts as "ready" for first paint; we'll still revalidate
      // in the background based on per-tier TTLs.
      setCriticalReady(true);
      setExtendedReady(true);
    }

    if (!navigator.onLine) {
      setLoading(false);
      return;
    }

    const cacheAge = cached ? Date.now() - cached.cachedAt : Infinity;
    const needsCritical = force || cacheAge > CRITICAL_TTL_MS;
    const needsExtended = force || cacheAge > EXTENDED_TTL_MS;

    if (!needsCritical && !needsExtended) {
      setLoading(false);
      return;
    }

    // Stage 1: critical (wallet + profile) — awaited so first paint happens fast.
    if (needsCritical) {
      await fetchTier('critical', force);
    }
    setLoading(false);

    // Stage 2: extended (everything else) — fire-and-forget in background.
    if (needsExtended) {
      void fetchTier('extended', force);
    }
  }, [userId, fetchTier]);

  useEffect(() => {
    if (userId) {
      fetchSnapshot();
    }
  }, [userId, fetchSnapshot]);

  // Refresh on tab focus if data is stale (no aggressive polling).
  useEffect(() => {
    if (!userId) return;
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (!lastFetched) return;
      if (Date.now() - lastFetched > CRITICAL_TTL_MS) {
        void fetchSnapshot(false);
      }
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [userId, lastFetched, fetchSnapshot]);

  return {
    snapshot,
    loading,
    criticalReady,
    extendedReady,
    criticalError,
    extendedError,
    refresh: () => fetchSnapshot(true),
    refreshCritical: () => fetchTier('critical', true),
    refreshExtended: () => fetchTier('extended', true),
    lastFetched,
  };
}
