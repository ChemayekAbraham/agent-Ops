// Comprehensive IndexedDB-based offline storage for app data
// Extends chat offline storage to cover wallet, profile, dashboard data

const DB_NAME = 'welile-offline-data';
const DB_VERSION = 3; // Incremented for new stores

// Store names
const STORES = {
  PROFILE: 'profile',
  WALLET: 'wallet',
  TRANSACTIONS: 'transactions',
  RENT_REQUESTS: 'rentRequests',
  NOTIFICATIONS: 'notifications',
  DASHBOARD_DATA: 'dashboardData',
  USER_ROLES: 'userRoles',
  SYNC_QUEUE: 'syncQueue',
  AGENT_STATS: 'agentStats',
  EARNINGS: 'earnings',
} as const;

interface SyncQueueItem {
  id: string;
  type: 'create' | 'update' | 'delete';
  table: string;
  data: any;
  createdAt: string;
  retryCount: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function resetDb(): void {
  dbPromise = null;
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        resetDb();
      };
      db.onclose = () => resetDb();
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create stores if they don't exist
      Object.values(STORES).forEach(storeName => {
        if (!db.objectStoreNames.contains(storeName)) {
          if (storeName === STORES.SYNC_QUEUE) {
            const store = db.createObjectStore(storeName, { keyPath: 'id' });
            store.createIndex('type', 'type', { unique: false });
          } else {
            db.createObjectStore(storeName, { keyPath: 'id' });
          }
        }
      });
    };
  });
  dbPromise = p;
  p.catch(() => { if (dbPromise === p) resetDb(); });
  return p;
}

function isStaleConnectionError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return /closing|InvalidState|in-progress/i.test(`${e?.name ?? ''} ${e?.message ?? ''}`);
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T> | T): Promise<T> {
  try {
    return await fn(await openDB());
  } catch (err) {
    if (!isStaleConnectionError(err)) throw err;
    resetDb();
    return await fn(await openDB());
  }
}

// Generic cache and get functions
async function cacheData<T extends { id: string }>(
  storeName: string,
  data: T | T[]
): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      store.put({ ...item, _cachedAt: Date.now() });
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn(`[OfflineData] Failed to cache ${storeName}:`, error);
  }
}

async function getCachedData<T>(storeName: string, id?: string): Promise<T | T[] | null> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = id ? store.get(id) : store.getAll();

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  });
  } catch (error) {
    console.warn(`[OfflineData] Failed to get ${storeName}:`, error);
    return null;
  }
}

async function clearStore(storeName: string): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn(`[OfflineData] Failed to clear ${storeName}:`, error);
  }
}

// Profile
export async function cacheProfile(profile: any): Promise<void> {
  return cacheData(STORES.PROFILE, profile);
}

export async function getCachedProfile(userId: string): Promise<any | null> {
  return getCachedData(STORES.PROFILE, userId);
}

// Wallet
export async function cacheWallet(wallet: any): Promise<void> {
  return cacheData(STORES.WALLET, wallet);
}

export async function getCachedWallet(userId: string): Promise<any | null> {
  const wallets = await getCachedData<any[]>(STORES.WALLET);
  return wallets?.find(w => w.user_id === userId) || null;
}

// Transactions
export async function cacheTransactions(transactions: any[]): Promise<void> {
  return cacheData(STORES.TRANSACTIONS, transactions);
}

export async function getCachedTransactions(): Promise<any[]> {
  const data = await getCachedData<any[]>(STORES.TRANSACTIONS);
  return data || [];
}

// Rent Requests
export async function cacheRentRequests(requests: any[]): Promise<void> {
  return cacheData(STORES.RENT_REQUESTS, requests);
}

export async function getCachedRentRequests(): Promise<any[]> {
  const data = await getCachedData<any[]>(STORES.RENT_REQUESTS);
  return data || [];
}

// Notifications
export async function cacheNotifications(notifications: any[]): Promise<void> {
  return cacheData(STORES.NOTIFICATIONS, notifications);
}

export async function getCachedNotifications(): Promise<any[]> {
  const data = await getCachedData<any[]>(STORES.NOTIFICATIONS);
  return data || [];
}

// Dashboard Data (role-specific cached data)
export async function cacheDashboardData(userId: string, role: string, data: any): Promise<void> {
  return cacheData(STORES.DASHBOARD_DATA, { 
    id: `${userId}-${role}`, 
    userId, 
    role, 
    data 
  });
}

export async function getCachedDashboardData(userId: string, role: string): Promise<any | null> {
  const result = await getCachedData<any>(STORES.DASHBOARD_DATA, `${userId}-${role}`);
  return result?.data || null;
}

// User Roles
export async function cacheUserRoles(userId: string, roles: string[]): Promise<void> {
  return cacheData(STORES.USER_ROLES, { id: userId, roles });
}

export async function getCachedUserRoles(userId: string): Promise<string[]> {
  const result = await getCachedData<any>(STORES.USER_ROLES, userId);
  return result?.roles || [];
}

// Agent Stats - role-specific cached agent data
export async function cacheAgentStats(agentId: string, data: any): Promise<void> {
  return cacheData(STORES.AGENT_STATS, { id: agentId, ...data });
}

export async function getCachedAgentStats(agentId: string): Promise<any | null> {
  return getCachedData(STORES.AGENT_STATS, agentId);
}

// Earnings
export async function cacheEarnings(userId: string, earnings: any[]): Promise<void> {
  return cacheData(STORES.EARNINGS, { id: userId, data: earnings });
}

export async function getCachedEarnings(userId: string): Promise<any[] | null> {
  const result = await getCachedData<any>(STORES.EARNINGS, userId);
  return result?.data || null;
}

// Sync Queue - for offline mutations
export async function addToSyncQueue(item: Omit<SyncQueueItem, 'id' | 'createdAt' | 'retryCount'>): Promise<void> {
  const queueItem: SyncQueueItem = {
    ...item,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    retryCount: 0,
  };
  return cacheData(STORES.SYNC_QUEUE, queueItem);
}

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  const data = await getCachedData<SyncQueueItem>(STORES.SYNC_QUEUE);
  // getCachedData returns T[] when no id is provided, T | null otherwise
  if (Array.isArray(data)) {
    return data as SyncQueueItem[];
  }
  return data ? [data] : [];
}

export async function removeFromSyncQueue(id: string): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
    tx.objectStore(STORES.SYNC_QUEUE).delete(id);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineData] Failed to remove from sync queue:', error);
  }
}

export async function updateSyncQueueItem(id: string, updates: Partial<SyncQueueItem>): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(STORES.SYNC_QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.SYNC_QUEUE);
    const request = store.get(id);

    request.onsuccess = () => {
      if (request.result) {
        store.put({ ...request.result, ...updates });
      }
    };

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineData] Failed to update sync queue item:', error);
  }
}

// Clear all offline data (for logout)
export async function clearAllOfflineData(): Promise<void> {
  await Promise.all(
    Object.values(STORES).map(storeName => clearStore(storeName))
  );
}

// Get cache age
export async function getCacheAge(storeName: string, id?: string): Promise<number | null> {
  const data = await getCachedData<any>(storeName, id);
  // Handle both single items and arrays
  const item = Array.isArray(data) ? data[0] : data;
  if (item?._cachedAt) {
    return Date.now() - item._cachedAt;
  }
  return null;
}

// Check if cache is stale (older than maxAge in ms)
export function isCacheStale(cacheAge: number | null, maxAgeMs: number = 5 * 60 * 1000): boolean {
  if (cacheAge === null) return true;
  return cacheAge > maxAgeMs;
}
