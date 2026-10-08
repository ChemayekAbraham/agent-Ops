import { safeUUID } from '@/lib/safeUUID';
/**
 * Offline-first store for Field Collections.
 * Uses IndexedDB to:
 *   1) Cache the agent's tenant list (loaded when online).
 *   2) Queue field collection entries captured offline.
 *
 * Per-agent scoped (keyed by agentId) so multiple accounts on one device stay isolated.
 */

const DB_NAME = 'welile-field-collect';
const DB_VERSION = 3;
const STORE_TENANTS = 'tenants';
const STORE_ENTRIES = 'entries';
/**
 * Persisted normalized phone/name index for the tenant picker.
 * Keyed by [agentId, fingerprint] so we re-use the cache across reloads
 * as long as the underlying tenant list (ids) hasn't changed.
 */
const STORE_TENANT_NORM = 'tenant_norm_cache';
/**
 * Persisted "recent / frequent tenants" pick log for the picker.
 * One row per (agentId, tenantId) tracking pickCount + lastPickedAt so a
 * tenant the agent reaches for often surfaces at the top across reloads,
 * even before they've recorded a new field collection. Keyed by
 * [agentId, tenantId] for O(1) bump on every pick.
 */
const STORE_TENANT_PICKS = 'tenant_picks';

export interface CachedTenant {
  agentId: string;
  tenantId: string;
  fullName: string;
  phone: string | null;
  monthlyRent?: number | null;
  cachedAt: number;
}

export interface FieldEntry {
  id: string;            // client_uuid (also used in DB unique constraint)
  agentId: string;
  tenantId: string | null;
  tenantName: string;
  tenantPhone: string | null;
  amount: number;
  notes?: string | null;
  locationName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  capturedAt: number;    // ms epoch
  /**
   * 'queued'    = needs sync
   * 'synced'    = pushed to server pending review
   * 'error'    = failed last sync (will retry)
   * 'duplicate' = server rejected as duplicate of an already-uploaded receipt
   *              (idempotency key collision — needs human reconciliation)
   */
  syncState: 'queued' | 'synced' | 'error' | 'duplicate';
  syncError?: string | null;
  serverId?: string | null;
  /** When syncState='duplicate', the server-side field_collections.id this entry collided with */
  duplicateOfServerId?: string | null;
  /** Snapshot of the server record at the moment the duplicate was detected (for side-by-side review) */
  duplicateServerSnapshot?: {
    amount: number;
    capturedAt: string;
    tenantName: string | null;
    status: string;
    createdAt: string;
  } | null;
  /** Last sync attempt timestamp (ms epoch) — used for backoff / display */
  lastSyncAt?: number | null;
}

/**
 * One shared connection per page, reopened only when the browser closes it.
 *
 * This used to open a fresh connection on every call and never close any of
 * them, so a long agent-dashboard session piled up hundreds of dangling
 * connections. When the browser tore them down (storage pressure, a
 * backgrounded tab being frozen, site data cleared) the next
 * `db.transaction()` threw "The database connection is closing" (WebKit:
 * "...without an in-progress transaction") as an unhandled rejection — the
 * top live /dashboard/agent client error in the 2026-09-27 CTO report.
 */
let dbPromise: Promise<IDBDatabase> | null = null;
/** Connections known to be closed/closing (device sleep, version change). */
const closedDbs = new WeakSet<IDBDatabase>();

/** Resolve a live connection, discarding a cached one that has been closed. */
async function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    const cached = await dbPromise.catch(() => null);
    if (cached && !closedDbs.has(cached)) return cached;
    dbPromise = null;
  }
  return openDbFresh();
}

function openDbFresh(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TENANTS)) {
        const s = db.createObjectStore(STORE_TENANTS, { keyPath: ['agentId', 'tenantId'] });
        s.createIndex('by_agent', 'agentId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const s = db.createObjectStore(STORE_ENTRIES, { keyPath: 'id' });
        s.createIndex('by_agent', 'agentId', { unique: false });
        s.createIndex('by_agent_state', ['agentId', 'syncState'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_TENANT_NORM)) {
        const s = db.createObjectStore(STORE_TENANT_NORM, { keyPath: ['agentId', 'fingerprint'] });
        s.createIndex('by_agent', 'agentId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_TENANT_PICKS)) {
        const s = db.createObjectStore(STORE_TENANT_PICKS, { keyPath: ['agentId', 'tenantId'] });
        s.createIndex('by_agent', 'agentId', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema, or the browser closing the
      // connection abnormally: drop it so the next call reopens cleanly.
      db.onversionchange = () => { closedDbs.add(db); try { db.close(); } catch { /* ignore */ } if (dbPromise === p) dbPromise = null; };
      db.onclose = () => { closedDbs.add(db); if (dbPromise === p) dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? namedError('UnknownError', 'Offline storage could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
  dbPromise = p;
  p.catch(() => { if (dbPromise === p) dbPromise = null; });
  return p;
}

function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/**
 * The error to reject with when a transaction fails. `t.error` is null when a
 * transaction is aborted without a request error (e.g. the browser force-closes
 * the connection), so fall back to an AbortError the retry check recognises.
 */
function txError(t: IDBTransaction): Error {
  return t.error ?? namedError('AbortError', 'The offline storage transaction was aborted');
}

const STORAGE_FULL_MESSAGE = 'Phone storage is full. Free up some space, then try again.';
const STORAGE_DEAD_MESSAGE = 'Offline storage stopped responding. Reload the page and try again.';

/** Errors a retry can never fix: bad data, schema conflicts, or a full disk. */
const NON_RETRYABLE_NAMES = new Set(['QuotaExceededError', 'ConstraintError', 'DataError', 'VersionError', 'DataCloneError']);

function errorName(e: unknown): string {
  return String((e as { name?: string } | null)?.name ?? '');
}

function isQuotaError(e: unknown): boolean {
  return errorName(e) === 'QuotaExceededError';
}

/**
 * True when the connection or the browser's storage backend dropped out from
 * under us, so a fresh connection may succeed:
 *  - InvalidStateError / "connection is closing": the connection was closed.
 *  - UnknownError / "Indexed Database server": WebKit lost its storage
 *    process (iOS Safari after backgrounding).
 *  - AbortError: pending work aborted because the connection was force-closed.
 *    Aborts caused by quota or constraint failures carry those names instead,
 *    so they are excluded above.
 */
function isRetryableStorageError(e: unknown): boolean {
  const name = errorName(e);
  if (NON_RETRYABLE_NAMES.has(name)) return false;
  if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'AbortError') return true;
  const msg = String((e as { message?: string } | null)?.message ?? '');
  return /connection is closing|in-progress transaction|indexed database server/i.test(msg);
}

/** Safari's storage process reconnects asynchronously; give it a moment. */
const RETRY_DELAY_MS = 150;

/**
 * Run `fn` against the shared connection. If opening or using it fails in a
 * way a fresh connection can fix (see `isRetryableStorageError`), discard it
 * and retry exactly once.
 *
 * Retrying is safe: a failed IndexedDB transaction commits nothing, and every
 * write here is keyed (put/delete by id), so a repeat can't double-write.
 *
 * If the retry fails the same way, the browser's IndexedDB backend is gone for
 * this page (iOS Safari loses it after backgrounding; only a reload brings it
 * back — 2026-09-28: one agent hit this every few seconds for 2h after the
 * doc-142 fix). Say so instead of surfacing the raw DOM message.
 */
async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    return await fn(db);
  } catch (e) {
    if (isQuotaError(e)) throw new Error(STORAGE_FULL_MESSAGE);
    if (!isRetryableStorageError(e)) throw e;
    if (dbPromise) {
      const current = await dbPromise.catch(() => null);
      if (!current || current === db) dbPromise = null;
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      return await fn(await openDb());
    } catch (e2) {
      if (isQuotaError(e2)) throw new Error(STORAGE_FULL_MESSAGE);
      if (!isRetryableStorageError(e2)) throw e2;
      dbPromise = null;
      throw new Error(STORAGE_DEAD_MESSAGE);
    }
  }
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return withDb(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result: any;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result as T);
    t.onerror = () => reject(txError(t));
    t.onabort = () => reject(txError(t));
  }));
}

/* ----------------- Tenant cache ----------------- */

export async function cacheTenants(agentId: string, tenants: Array<Omit<CachedTenant, 'agentId' | 'cachedAt'>>): Promise<void> {
  await withDb(db => new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_TENANTS, 'readwrite');
    const s = t.objectStore(STORE_TENANTS);
    // Replace existing cache for this agent
    const idx = s.index('by_agent');
    const cursorReq = idx.openCursor(IDBKeyRange.only(agentId));
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur) {
        cur.delete();
        cur.continue();
      } else {
        const now = Date.now();
        for (const tn of tenants) {
          s.put({ ...tn, agentId, cachedAt: now });
        }
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(txError(t));
    t.onabort = () => reject(txError(t));
  }));
}

export async function getCachedTenants(agentId: string): Promise<CachedTenant[]> {
  return withDb(db => new Promise<CachedTenant[]>((resolve, reject) => {
    const t = db.transaction(STORE_TENANTS, 'readonly');
    const s = t.objectStore(STORE_TENANTS).index('by_agent');
    const req = s.getAll(IDBKeyRange.only(agentId));
    req.onsuccess = () => resolve((req.result || []) as CachedTenant[]);
    req.onerror = () => reject(req.error ?? txError(t));
    t.onabort = () => reject(txError(t));
  }));
}

/* ----------------- Normalized tenant index cache -----------------
 *
 * The picker pre-computes normalized phone/name strings for every cached
 * tenant. That work is cheap per-tenant but adds up for agents with
 * thousands of tenants — and we'd otherwise redo it on every cold start.
 *
 * We persist the computed entries keyed by a fingerprint of the tenant
 * list (ids + names + phones). On reload the picker can hydrate the
 * index synchronously-ish (one IndexedDB read) and only recompute when
 * the underlying list actually changes.
 */

export interface NormalizedTenantEntry {
  tenantId: string;
  name: string;
  phone: string;
  nameWords: string[];
}

interface NormalizedIndexRecord {
  agentId: string;
  fingerprint: string;
  entries: NormalizedTenantEntry[];
  cachedAt: number;
}

export async function getCachedNormalizedIndex(
  agentId: string,
  fingerprint: string,
): Promise<NormalizedTenantEntry[] | null> {
  try {
    return await withDb(db => new Promise<NormalizedTenantEntry[] | null>((resolve, reject) => {
      const t = db.transaction(STORE_TENANT_NORM, 'readonly');
      const s = t.objectStore(STORE_TENANT_NORM);
      const req = s.get([agentId, fingerprint]);
      req.onsuccess = () => {
        const rec = req.result as NormalizedIndexRecord | undefined;
        resolve(rec?.entries ?? null);
      };
      req.onerror = () => reject(req.error ?? txError(t));
      t.onabort = () => reject(txError(t));
    }));
  } catch (e) {
    console.warn('getCachedNormalizedIndex failed', e);
    return null;
  }
}

export async function saveCachedNormalizedIndex(
  agentId: string,
  fingerprint: string,
  entries: NormalizedTenantEntry[],
): Promise<void> {
  try {
    await withDb(db => new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_TENANT_NORM, 'readwrite');
      const s = t.objectStore(STORE_TENANT_NORM);
      // Drop any prior fingerprints for this agent so the cache stays small.
      const idx = s.index('by_agent');
      const cursorReq = idx.openCursor(IDBKeyRange.only(agentId));
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (cur) {
          cur.delete();
          cur.continue();
        } else {
          const rec: NormalizedIndexRecord = {
            agentId,
            fingerprint,
            entries,
            cachedAt: Date.now(),
          };
          s.put(rec);
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(txError(t));
      t.onabort = () => reject(txError(t));
    }));
  } catch (e) {
    console.warn('saveCachedNormalizedIndex failed', e);
  }
}

/* ----------------- Entries queue ----------------- */

/**
 * Lightweight pub/sub so any UI can refresh the moment an entry changes.
 * Consumers should subscribe via `onFieldCollectChange` and re-fetch via `getEntries`.
 */
export type FieldCollectChangeAction = 'add' | 'update' | 'delete';
export const FIELD_COLLECT_CHANGE_EVENT = 'welile:field-collect-change';

function emitFieldCollectChange(action: FieldCollectChangeAction, agentId?: string) {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent(FIELD_COLLECT_CHANGE_EVENT, { detail: { action, agentId } }),
    );
  } catch {
    /* ignore — environments without CustomEvent */
  }
}

export function onFieldCollectChange(
  handler: (detail: { action: FieldCollectChangeAction; agentId?: string }) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event) => handler((e as CustomEvent).detail);
  window.addEventListener(FIELD_COLLECT_CHANGE_EVENT, listener);
  return () => window.removeEventListener(FIELD_COLLECT_CHANGE_EVENT, listener);
}

export async function addEntry(entry: FieldEntry): Promise<void> {
  await tx(STORE_ENTRIES, 'readwrite', (s) => s.put(entry));
  emitFieldCollectChange('add', entry.agentId);
}

export async function updateEntry(id: string, patch: Partial<FieldEntry>): Promise<void> {
  await withDb(db => new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_ENTRIES, 'readwrite');
    const s = t.objectStore(STORE_ENTRIES);
    const getReq = s.get(id);
    getReq.onsuccess = () => {
      const cur = getReq.result as FieldEntry | undefined;
      if (!cur) { resolve(); return; }
      s.put({ ...cur, ...patch });
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(txError(t));
    t.onabort = () => reject(txError(t));
  }));
  emitFieldCollectChange('update');
}

export async function deleteEntry(id: string): Promise<void> {
  await tx(STORE_ENTRIES, 'readwrite', (s) => s.delete(id));
  emitFieldCollectChange('delete');
}

export async function getEntries(agentId: string): Promise<FieldEntry[]> {
  return withDb(db => new Promise<FieldEntry[]>((resolve, reject) => {
    const t = db.transaction(STORE_ENTRIES, 'readonly');
    const s = t.objectStore(STORE_ENTRIES).index('by_agent');
    const req = s.getAll(IDBKeyRange.only(agentId));
    req.onsuccess = () => {
      const all = (req.result || []) as FieldEntry[];
      all.sort((a, b) => b.capturedAt - a.capturedAt);
      resolve(all);
    };
    req.onerror = () => reject(req.error ?? txError(t));
    t.onabort = () => reject(txError(t));
  }));
}

export async function getQueuedEntries(agentId: string): Promise<FieldEntry[]> {
  const all = await getEntries(agentId);
  return all.filter(e => e.syncState === 'queued' || e.syncState === 'error');
}

export async function getDuplicateEntries(agentId: string): Promise<FieldEntry[]> {
  const all = await getEntries(agentId);
  return all.filter(e => e.syncState === 'duplicate');
}

/** UUID v4 — works without crypto.randomUUID on older mobile WebViews */
export function newClientUuid(): string {
  return safeUUID();
}

/* ----------------- Tenant pick log -----------------
 *
 * Tracks how often (and how recently) the agent has tapped each tenant in
 * the picker so we can surface a persistent "Recent" section that survives
 * reloads. Independent of the entries queue: a tenant counts as "picked"
 * the moment the agent opens them in the dialog, even if they back out
 * before saving an amount.
 */

export interface TenantPickRecord {
  agentId: string;
  tenantId: string;
  pickCount: number;
  lastPickedAt: number;
}

/** Hard cap so the store never grows unbounded for an agent that's been
 *  using the app for years. Trim down to MAX_KEEP after every bump. */
const PICK_LOG_MAX = 200;
const PICK_LOG_KEEP = 100;

/** Increment (or insert) the pick log for one tenant. Fire-and-forget — the
 *  caller doesn't await this on the hot path. */
export async function bumpTenantPick(agentId: string, tenantId: string): Promise<void> {
  if (!agentId || !tenantId) return;
  try {
    await withDb(db => new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_TENANT_PICKS, 'readwrite');
      const s = t.objectStore(STORE_TENANT_PICKS);
      const getReq = s.get([agentId, tenantId]);
      getReq.onsuccess = () => {
        const cur = getReq.result as TenantPickRecord | undefined;
        const next: TenantPickRecord = {
          agentId,
          tenantId,
          pickCount: (cur?.pickCount ?? 0) + 1,
          lastPickedAt: Date.now(),
        };
        s.put(next);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(txError(t));
      t.onabort = () => reject(txError(t));
    }));
    // Trim opportunistically when we cross the cap. Cheap relative to the
    // many writes it follows, and keeps cold-start reads bounded.
    void trimTenantPicks(agentId);
  } catch (e) {
    console.warn('bumpTenantPick failed', e);
  }
}

/** Read the agent's full pick log, sorted by most-recently-picked first.
 *  Callers usually combine `pickCount` + `lastPickedAt` to rank. */
export async function getRecentPicks(agentId: string): Promise<TenantPickRecord[]> {
  if (!agentId) return [];
  try {
    return await withDb(db => new Promise<TenantPickRecord[]>((resolve, reject) => {
      const t = db.transaction(STORE_TENANT_PICKS, 'readonly');
      const s = t.objectStore(STORE_TENANT_PICKS).index('by_agent');
      const req = s.getAll(IDBKeyRange.only(agentId));
      req.onsuccess = () => {
        const all = (req.result || []) as TenantPickRecord[];
        all.sort((a, b) => b.lastPickedAt - a.lastPickedAt);
        resolve(all);
      };
      req.onerror = () => reject(req.error ?? txError(t));
      t.onabort = () => reject(txError(t));
    }));
  } catch (e) {
    console.warn('getRecentPicks failed', e);
    return [];
  }
}

/** Drop the oldest pick rows once the agent crosses PICK_LOG_MAX so the
 *  store stays bounded. Called fire-and-forget after each bump. */
async function trimTenantPicks(agentId: string): Promise<void> {
  try {
    const all = await getRecentPicks(agentId);
    if (all.length <= PICK_LOG_MAX) return;
    const toDelete = all.slice(PICK_LOG_KEEP); // keep the freshest PICK_LOG_KEEP
    await withDb(db => new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE_TENANT_PICKS, 'readwrite');
      const s = t.objectStore(STORE_TENANT_PICKS);
      for (const r of toDelete) s.delete([r.agentId, r.tenantId]);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(txError(t));
      t.onabort = () => reject(txError(t));
    }));
  } catch {
    /* best-effort cleanup */
  }
}