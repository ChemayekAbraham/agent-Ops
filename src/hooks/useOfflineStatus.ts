import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

interface OfflineStatus {
  isOnline: boolean;
  isSlowConnection: boolean;
  connectionType: string | null;
}

export function useOfflineStatus(): OfflineStatus {
  const [status, setStatus] = useState<OfflineStatus>({
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isSlowConnection: false,
    connectionType: null,
  });

  const updateConnectionInfo = useCallback(() => {
    const connection = (navigator as any).connection || 
                       (navigator as any).mozConnection || 
                       (navigator as any).webkitConnection;

    if (connection) {
      const isSlowConnection = 
        connection.effectiveType === '2g' || 
        connection.effectiveType === 'slow-2g' ||
        connection.saveData === true;

      setStatus(prev => ({
        ...prev,
        isSlowConnection,
        connectionType: connection.effectiveType || null,
      }));
    }
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setStatus(prev => ({ ...prev, isOnline: true }));
      toast.success('Back online!', {
        description: 'Your connection has been restored.',
        duration: 3000,
      });
      updateConnectionInfo();
    };

    const handleOffline = () => {
      setStatus(prev => ({ ...prev, isOnline: false }));
      toast.error('You\'re offline', {
        description: 'Some features may be limited.',
        duration: 5000,
      });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Listen for connection changes
    const connection = (navigator as any).connection;
    if (connection) {
      connection.addEventListener('change', updateConnectionInfo);
    }

    // Initial check
    updateConnectionInfo();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (connection) {
        connection.removeEventListener('change', updateConnectionInfo);
      }
    };
  }, [updateConnectionInfo]);

  return status;
}

// Hook to handle service worker updates
export function useServiceWorker() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SYNC_COMPLETE') {
        toast.success('Data synced!', {
          description: 'Your pending actions have been synchronized.',
          duration: 3000,
        });
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);

    // Check for updates
    navigator.serviceWorker.ready.then((registration) => {
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
              toast.info('Update available!', {
                description: 'Refresh to get the latest version.',
                action: {
                  label: 'Refresh',
                  onClick: () => window.location.reload(),
                },
                duration: 10000,
              });
            }
          });
        }
      });
    });

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleMessage);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage('skipWaiting');
      window.location.reload();
    }
  }, []);

  return { updateAvailable, applyUpdate };
}
