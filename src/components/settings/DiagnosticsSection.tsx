import { useState, useEffect, useCallback } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bug, Download, RefreshCw, Wifi, WifiOff, HardDrive, Trash2, Check, X, Loader2, Info, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

declare const __APP_VERSION__: string;

interface DiagnosticsInfo {
  isInstalled: boolean;
  isOnline: boolean;
  swState: string;
  swScope: string;
  cacheSize: string;
  cachesCount: number;
}

export default function DiagnosticsSection() {
  const queryClient = useQueryClient();
  const [info, setInfo] = useState<DiagnosticsInfo>({
    isInstalled: false,
    isOnline: navigator.onLine,
    swState: 'checking...',
    swScope: 'N/A',
    cacheSize: 'calculating...',
    cachesCount: 0,
  });
  const [clearing, setClearing] = useState(false);
  const [refreshingData, setRefreshingData] = useState(false);
  const [isIOSStandalone, setIsIOSStandalone] = useState(false);

  // Detect iOS standalone mode
  useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    const isStandalone = (window.navigator as any).standalone === true || 
                         window.matchMedia('(display-mode: standalone)').matches;
    setIsIOSStandalone(isIOS && isStandalone);
  }, []);

  const checkInstallStatus = useCallback(() => {
    // Check if running as PWA
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    return isStandalone;
  }, []);

  const checkServiceWorker = useCallback(async (): Promise<{ state: string; scope: string }> => {
    if (!('serviceWorker' in navigator)) {
      return { state: 'not supported', scope: 'N/A' };
    }

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        return { state: 'not registered', scope: 'N/A' };
      }

      let state = 'unknown';
      if (registration.active) state = 'active';
      else if (registration.waiting) state = 'waiting';
      else if (registration.installing) state = 'installing';

      return { state, scope: registration.scope };
    } catch {
      return { state: 'error', scope: 'N/A' };
    }
  }, []);

  const calculateCacheSize = useCallback(async (): Promise<{ size: string; count: number }> => {
    if (!('caches' in window)) {
      return { size: 'not supported', count: 0 };
    }

    try {
      const keys = await caches.keys();
      const welileCaches = keys.filter(k => k.startsWith('welile-'));
      let totalSize = 0;

      for (const cacheName of welileCaches) {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        for (const request of requests) {
          const response = await cache.match(request);
          if (response) {
            const blob = await response.clone().blob();
            totalSize += blob.size;
          }
        }
      }

      // Format size
      let sizeStr: string;
      if (totalSize < 1024) {
        sizeStr = `${totalSize} B`;
      } else if (totalSize < 1024 * 1024) {
        sizeStr = `${(totalSize / 1024).toFixed(1)} KB`;
      } else {
        sizeStr = `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
      }

      return { size: sizeStr, count: welileCaches.length };
    } catch {
      return { size: 'error', count: 0 };
    }
  }, []);

  const refreshDiagnostics = useCallback(async () => {
    const [swInfo, cacheInfo] = await Promise.all([
      checkServiceWorker(),
      calculateCacheSize(),
    ]);

    setInfo({
      isInstalled: checkInstallStatus(),
      isOnline: navigator.onLine,
      swState: swInfo.state,
      swScope: swInfo.scope,
      cacheSize: cacheInfo.size,
      cachesCount: cacheInfo.count,
    });
  }, [checkInstallStatus, checkServiceWorker, calculateCacheSize]);

  useEffect(() => {
    refreshDiagnostics();

    const handleOnline = () => setInfo(prev => ({ ...prev, isOnline: true }));
    const handleOffline = () => setInfo(prev => ({ ...prev, isOnline: false }));

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [refreshDiagnostics]);

  const handleClearCache = async () => {
    setClearing(true);

    try {
      // Unregister service workers
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(r => r.unregister()));
      }

      // Clear caches
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('welile-')).map(k => caches.delete(k)));
      }

      toast.success('Cache cleared! Reloading...');
      
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      console.error('Error clearing cache:', error);
      toast.error('Failed to clear cache');
      setClearing(false);
    }
  };

  // iOS-specific: Force refresh all data without clearing cache
  const handleForceRefreshData = async () => {
    setRefreshingData(true);
    
    try {
      console.log('[iOS] Force refreshing all data...');
      
      // Force service worker update check
      if ('serviceWorker' in navigator) {
        try {
          const registration = await navigator.serviceWorker.ready;
          await registration.update();
          if (registration.waiting) {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        } catch (e) {
          console.warn('[iOS] SW update check failed:', e);
        }
      }

      // Clear React Query caches and refetch all data
      queryClient.clear();
      await queryClient.invalidateQueries();
      await queryClient.refetchQueries({ type: 'all' });
      
      // Clear API cache specifically
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter(k => k.includes('api') || k.includes('supabase'))
            .map(k => caches.delete(k))
        );
      }
      
      toast.success('Data refreshed!', {
        description: 'All figures have been updated with the latest data.',
      });
    } catch (error) {
      console.error('[iOS] Force refresh failed:', error);
      toast.error('Failed to refresh data');
    } finally {
      setRefreshingData(false);
    }
  };

  const StatusBadge = ({ good, label }: { good: boolean; label: string }) => (
    <Badge variant={good ? 'default' : 'secondary'} className="gap-1">
      {good ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      {label}
    </Badge>
  );


  return (
    <Card className="glass-card border-border/50 shadow-elevated overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-muted/5 via-transparent to-primary/5 pointer-events-none" />
      
      <CardHeader className="relative">
        <CardTitle className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-muted/50">
            <Bug className="h-5 w-5 text-muted-foreground" />
          </div>
          Diagnostics
        </CardTitle>
        <CardDescription>
          Troubleshooting information for support
        </CardDescription>
      </CardHeader>
      
      <CardContent className="space-y-4 relative">
        {/* App Version */}
        <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">App Version</span>
            <Badge variant="outline" className="ml-auto font-mono text-xs">
              {__APP_VERSION__}
            </Badge>
          </div>
        </div>

        {/* Status Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Install Status */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <Download className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Install Status</span>
            </div>
            <StatusBadge good={info.isInstalled} label={info.isInstalled ? 'Installed' : 'Not Installed'} />
          </div>

          {/* Network Status */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              {info.isOnline ? (
                <Wifi className="h-4 w-4 text-success" />
              ) : (
                <WifiOff className="h-4 w-4 text-destructive" />
              )}
              <span className="text-sm font-medium">Network</span>
            </div>
            <StatusBadge good={info.isOnline} label={info.isOnline ? 'Online' : 'Offline'} />
          </div>

          {/* Service Worker Status */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Service Worker</span>
            </div>
            <StatusBadge 
              good={info.swState === 'active'} 
              label={info.swState.charAt(0).toUpperCase() + info.swState.slice(1)} 
            />
          </div>

          {/* Cache Size */}
          <div className="p-3 rounded-lg bg-background/50 border border-border/50">
            <div className="flex items-center gap-2 mb-1">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Cache Size</span>
            </div>
            <Badge variant="outline" className="gap-1">
              {info.cacheSize} ({info.cachesCount} caches)
            </Badge>
          </div>
        </div>

        {/* Actions */}
        <div className="pt-4 border-t border-border/50 space-y-3">
          {/* iOS Force Refresh - Prominent for iOS PWA users */}
          {isIOSStandalone && (
            <div className="mb-2">
              <Button 
                className="w-full gap-2 bg-primary hover:bg-primary/90" 
                onClick={handleForceRefreshData}
                disabled={refreshingData}
              >
                {refreshingData ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Smartphone className="h-4 w-4" />
                )}
                Force Refresh Data (iOS)
              </Button>
              <p className="text-xs text-muted-foreground mt-1 text-center">
                Tap to get the latest figures if data seems stale
              </p>
            </div>
          )}

          <div>
            <Button 
              variant="outline" 
              className="w-full gap-2" 
              onClick={refreshDiagnostics}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh Diagnostics
            </Button>
          </div>

          <div>
            <Button 
              variant="destructive" 
              className="w-full gap-2" 
              onClick={handleClearCache}
              disabled={clearing}
            >
              {clearing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Clear Cache & Reload
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
