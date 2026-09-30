// IndexedDB-based offline storage for chat messages and conversations

const DB_NAME = 'welile-chat-offline';
const DB_VERSION = 1;
const CONVERSATIONS_STORE = 'conversations';
const MESSAGES_STORE = 'messages';
const PENDING_MESSAGES_STORE = 'pendingMessages';

interface PendingMessage {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'sending' | 'failed';
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

      // Conversations store
      if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'id' });
      }

      // Messages store with conversation index
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const messagesStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
        messagesStore.createIndex('conversationId', 'conversation_id', { unique: false });
      }

      // Pending messages store for offline queue
      if (!db.objectStoreNames.contains(PENDING_MESSAGES_STORE)) {
        const pendingStore = db.createObjectStore(PENDING_MESSAGES_STORE, { keyPath: 'id' });
        pendingStore.createIndex('conversationId', 'conversationId', { unique: false });
      }
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

// Conversations
export async function cacheConversations(conversations: any[]): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
    const store = tx.objectStore(CONVERSATIONS_STORE);

    for (const conv of conversations) {
      store.put({ ...conv, cachedAt: new Date().toISOString() });
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to cache conversations:', error);
  }
}

export async function getCachedConversations(): Promise<any[]> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(CONVERSATIONS_STORE, 'readonly');
    const store = tx.objectStore(CONVERSATIONS_STORE);
    const request = store.getAll();

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to get cached conversations:', error);
    return [];
  }
}

// Messages
export async function cacheMessages(conversationId: string, messages: any[]): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGES_STORE);

    for (const msg of messages) {
      store.put({ ...msg, cachedAt: new Date().toISOString() });
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to cache messages:', error);
  }
}

export async function getCachedMessages(conversationId: string): Promise<any[]> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(MESSAGES_STORE, 'readonly');
    const store = tx.objectStore(MESSAGES_STORE);
    const index = store.index('conversationId');
    const request = index.getAll(conversationId);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to get cached messages:', error);
    return [];
  }
}

// Pending Messages (offline queue)
export async function queuePendingMessage(message: PendingMessage): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(PENDING_MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(PENDING_MESSAGES_STORE);
    store.put(message);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to queue pending message:', error);
  }
}

export async function getPendingMessages(): Promise<PendingMessage[]> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(PENDING_MESSAGES_STORE, 'readonly');
    const store = tx.objectStore(PENDING_MESSAGES_STORE);
    const request = store.getAll();

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to get pending messages:', error);
    return [];
  }
}

export async function getPendingMessagesForConversation(conversationId: string): Promise<PendingMessage[]> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(PENDING_MESSAGES_STORE, 'readonly');
    const store = tx.objectStore(PENDING_MESSAGES_STORE);
    const index = store.index('conversationId');
    const request = index.getAll(conversationId);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to get pending messages for conversation:', error);
    return [];
  }
}

export async function removePendingMessage(messageId: string): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(PENDING_MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(PENDING_MESSAGES_STORE);
    store.delete(messageId);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to remove pending message:', error);
  }
}

export async function updatePendingMessageStatus(
  messageId: string, 
  status: 'pending' | 'sending' | 'failed'
): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(PENDING_MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(PENDING_MESSAGES_STORE);
    const request = store.get(messageId);

    request.onsuccess = () => {
      if (request.result) {
        store.put({ ...request.result, status });
      }
    };

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to update pending message status:', error);
  }
}

// Get last sync timestamp
export async function getLastSyncTime(): Promise<string | null> {
  try {
    const conversations = await getCachedConversations();
    if (conversations.length === 0) return null;
    
    const cachedTimes = conversations
      .map(c => c.cachedAt)
      .filter(Boolean)
      .sort()
      .reverse();
    
    return cachedTimes[0] || null;
  } catch {
    return null;
  }
}

// Clear all offline data
export async function clearOfflineData(): Promise<void> {
  try {
    return withDb(async (db) => {
    const tx = db.transaction(
      [CONVERSATIONS_STORE, MESSAGES_STORE, PENDING_MESSAGES_STORE], 
      'readwrite'
    );
    
    tx.objectStore(CONVERSATIONS_STORE).clear();
    tx.objectStore(MESSAGES_STORE).clear();
    tx.objectStore(PENDING_MESSAGES_STORE).clear();

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  } catch (error) {
    console.warn('[OfflineStorage] Failed to clear offline data:', error);
  }
}
