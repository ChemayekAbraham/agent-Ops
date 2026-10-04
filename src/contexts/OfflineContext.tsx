import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { getSyncQueue, clearAllOfflineData } from '@/lib/offlineDataStorage';
import { runBatchSync } from '@/lib/syncEngine';

interface OfflineContextType {
  isOnline: boolean;
  isSlowConnection: boolean;
  pendingSyncCount: number;
  lastSyncTime: Date | null;
  syncNow: () => Promise<void>;
  clearOfflineData: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextType | undefined>(undefined);

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isSlowConnection, setIsSlowConnection] = useState(false);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const syncInProgress = useRef(false);
  const reconnectToastShown = useRef(false);
  const syncIntervalRef = useRef<number | null>(null);
  const currentBackoffMs = useRef(30000); // Start at 30s

  const checkConnectionQuality = useCallback(() => {
    const connection = (navigator as any).connection;
    if (connection) {
      const isSlow =
        connection.effectiveType === '2g' ||
        connection.effectiveType === 'slow-2g' ||
        connection.saveData === true;
      setIsSlowConnection(isSlow);
    }
  }, []);

  // Batched sync with exponential backoff on repeated failures
  const syncNow = useCallback(async () => {
    if (!isOnline || syncInProgress.current) return;

    syncInProgress.current = true;

    try {
      const result = await runBatchSync();

      const remainingQueue = await getSyncQueue();
      setPendingSyncCount(remainingQueue.length);
      setLastSyncTime(new Date());

      if (result.successCount > 0) {
        toast.success(`Synced ${result.successCount} change${result.successCount > 1 ? 's' : ''}`);
        // Reset backoff on success
        currentBackoffMs.current = 30000;
      }
      if (result.failCount > 0) {
        toast.error(`Failed to sync ${result.failCount} change${result.failCount > 1 ? 's' : ''}`);
        // Increase backoff on failures (max 5 min)
        currentBackoffMs.current = Math.min(currentBackoffMs.current * 2, 300000);
      }
    } catch (error) {
      console.error('[OfflineSync] Sync failed:', error);
      currentBackoffMs.current = Math.min(currentBackoffMs.current * 2, 300000);
    } finally {
      syncInProgress.current = false;
    }
  }, [isOnline]);

  const handleClearOfflineData = useCallback(async () => {
    await clearAllOfflineData();
    setPendingSyncCount(0);
    setLastSyncTime(null);
  }, []);

  // Online/offline handlers
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      if (!reconnectToastShown.current) {
        toast.success('Back online!', {
          description: 'Syncing your changes...',
          duration: 3000,
        });
        reconnectToastShown.current = true;
        setTimeout(() => { reconnectToastShown.current = false; }, 5000);
      }
      checkConnectionQuality();
      currentBackoffMs.current = 30000; // Reset backoff
      syncNow().catch(() => {});
    };

    const handleOffline = () => {
      setIsOnline(false);
      toast.warning('You\'re offline', {
        description: 'Changes will sync when you\'re back online.',
        duration: 5000,
      });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const connection = (navigator as any).connection;
    if (connection) {
      connection.addEventListener('change', checkConnectionQuality);
    }

    checkConnectionQuality();

    // DEFERRED: Load pending sync count after first paint
    const loadQueue = () => getSyncQueue().then(queue => setPendingSyncCount(queue.length)).catch(() => {});
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(loadQueue, { timeout: 3000 });
    } else {
      setTimeout(loadQueue, 1000);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (connection) {
        connection.removeEventListener('change', checkConnectionQuality);
      }
    };
  }, [checkConnectionQuality, syncNow]);

  // Adaptive sync interval with backoff
  useEffect(() => {
    if (!isOnline) return;

    const scheduleNext = () => {
      syncIntervalRef.current = window.setTimeout(async () => {
        await syncNow().catch(() => {});
        scheduleNext();
      }, currentBackoffMs.current);
    };

    scheduleNext();

    return () => {
      if (syncIntervalRef.current) {
        clearTimeout(syncIntervalRef.current);
      }
    };
  }, [isOnline, syncNow]);

  return (
    <OfflineContext.Provider
      value={{
        isOnline,
        isSlowConnection,
        pendingSyncCount,
        lastSyncTime,
        syncNow,
        clearOfflineData: handleClearOfflineData,
      }}
    >
      {children}
    </OfflineContext.Provider>
  );
}

// Safe fallback defaults when provider hasn't loaded yet
const offlineFallback: OfflineContextType = {
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  isSlowConnection: false,
  pendingSyncCount: 0,
  lastSyncTime: null,
  syncNow: async () => {},
  clearOfflineData: async () => {},
};

export function useOffline() {
  const context = useContext(OfflineContext);
  return context ?? offlineFallback;
}
