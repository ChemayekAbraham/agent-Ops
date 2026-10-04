// Sync engine with batched operations and exponential backoff
import { getSyncQueue, removeFromSyncQueue, updateSyncQueueItem } from './offlineDataStorage';
import { supabase } from '@/integrations/supabase/client';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000; // 1s, 2s, 4s, 8s, 16s

function getBackoffDelay(retryCount: number): number {
  // Exponential backoff with jitter
  const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
  const jitter = delay * 0.2 * Math.random();
  return delay + jitter;
}

interface SyncResult {
  successCount: number;
  failCount: number;
  retryLaterCount: number;
}

export async function runBatchSync(): Promise<SyncResult> {
  const queue = await getSyncQueue();
  if (queue.length === 0) return { successCount: 0, failCount: 0, retryLaterCount: 0 };

  // Filter items that are ready for retry (respect backoff delay)
  const now = Date.now();
  const readyItems = queue.filter(item => {
    if (item.retryCount === 0) return true;
    const lastAttempt = new Date(item.createdAt).getTime();
    const backoffDelay = getBackoffDelay(item.retryCount - 1);
    return (now - lastAttempt) > backoffDelay;
  });

  if (readyItems.length === 0) return { successCount: 0, failCount: 0, retryLaterCount: queue.length };

  // Try batch endpoint first
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { successCount: 0, failCount: 0, retryLaterCount: readyItems.length };
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  try {
    // Send batch to edge function
    const batchItems = readyItems.slice(0, 50).map(item => ({
      id: item.id,
      type: item.type,
      table: item.table,
      data: item.data,
      createdAt: item.createdAt,
    }));

    const response = await fetch(`${supabaseUrl}/functions/v1/batch-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': supabaseKey,
      },
      body: JSON.stringify({ items: batchItems }),
    });

    if (response.ok) {
      const { results } = await response.json();
      let successCount = 0;
      let failCount = 0;

      for (const result of results) {
        if (result.success) {
          await removeFromSyncQueue(result.id);
          successCount++;
        } else {
          // Find the item to check retry count
          const item = readyItems.find(i => i.id === result.id);
          if (item && item.retryCount >= MAX_RETRIES - 1) {
            await removeFromSyncQueue(result.id);
            failCount++;
          } else if (item) {
            await updateSyncQueueItem(result.id, { retryCount: item.retryCount + 1 });
          }
        }
      }

      return { successCount, failCount, retryLaterCount: queue.length - readyItems.length };
    }

    // If batch endpoint fails, fall back to individual sync
    return await individualSync(readyItems, session.access_token, supabaseUrl, supabaseKey);
  } catch {
    // Network error — fall back to individual sync
    return await individualSync(readyItems, session.access_token, supabaseUrl, supabaseKey);
  }
}

async function individualSync(
  items: Awaited<ReturnType<typeof getSyncQueue>>,
  accessToken: string,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<SyncResult> {
  let successCount = 0;
  let failCount = 0;

  const authHeader = { 'Authorization': `Bearer ${accessToken}` };

  for (const item of items) {
    try {
      const makeRequest = (): Promise<Response> => {
        if (item.type === 'create') {
          return fetch(`${supabaseUrl}/rest/v1/${item.table}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, ...authHeader },
            body: JSON.stringify(item.data),
          });
        } else if (item.type === 'update') {
          return fetch(`${supabaseUrl}/rest/v1/${item.table}?id=eq.${item.data.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, ...authHeader },
            body: JSON.stringify(item.data),
          });
        } else if (item.type === 'delete') {
          return fetch(`${supabaseUrl}/rest/v1/${item.table}?id=eq.${item.data.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, ...authHeader },
          });
        }
        throw new Error(`Unknown sync type: ${item.type}`);
      };

      const response = await makeRequest();

      if (response.ok) {
        await removeFromSyncQueue(item.id);
        successCount++;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch {
      if (item.retryCount >= MAX_RETRIES - 1) {
        await removeFromSyncQueue(item.id);
        failCount++;
      } else {
        await updateSyncQueueItem(item.id, { retryCount: item.retryCount + 1 });
      }
    }
  }

  return { successCount, failCount, retryLaterCount: 0 };
}
