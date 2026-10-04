/**
 * One-tap "clear app state" recovery.
 *
 * Wipes every piece of client-side state that can strand a user on a broken
 * session — service workers, cache storage, localStorage, sessionStorage, and
 * IndexedDB — then hard-reloads into `/auth`.
 *
 * This is the last-resort recovery when the stale-session detector's automatic
 * refresh has failed repeatedly. Safe to call at any time; the caller is
 * expected to have already confirmed with the user (destructive).
 */

async function unregisterServiceWorkers() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.allSettled(regs.map((r) => r.unregister()));
  } catch { /* ignore */ }
}

async function clearAllCaches() {
  try {
    if (!('caches' in window)) return;
    const names = await caches.keys();
    await Promise.allSettled(names.map((n) => caches.delete(n)));
  } catch { /* ignore */ }
}

function clearWebStorage() {
  try { localStorage.clear(); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
}

async function clearIndexedDB() {
  try {
    // Modern browsers expose `databases()`. Fall back to a best-effort
    // enumeration of the known Supabase / app databases.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyIdb = indexedDB as any;
    const dbs: Array<{ name?: string }> = anyIdb.databases ? await anyIdb.databases() : [];
    const names = new Set<string>(dbs.map((d) => d.name).filter(Boolean) as string[]);
    // Known suspects worth wiping even if enumeration is unsupported.
    ['supabase-auth', 'keyval-store', 'localforage', 'welile'].forEach((n) => names.add(n));
    await Promise.allSettled(
      Array.from(names).map(
        (name) =>
          new Promise<void>((resolve) => {
            try {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            } catch { resolve(); }
          }),
      ),
    );
  } catch { /* ignore */ }
}

export async function clearAppState(): Promise<void> {
  // Order matters: kill workers first so they can't repopulate caches during
  // teardown, then caches, then storage.
  await unregisterServiceWorkers();
  await clearAllCaches();
  clearWebStorage();
  await clearIndexedDB();
}

export async function clearAppStateAndReload(target = '/auth?reason=recovery'): Promise<void> {
  await clearAppState();
  try {
    // Force a full network reload — avoid bfcache.
    window.location.replace(target);
  } catch {
    window.location.href = target;
  }
}
