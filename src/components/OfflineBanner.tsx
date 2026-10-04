import { WifiOff, CloudOff, RefreshCw } from 'lucide-react';
import { useOffline } from '@/contexts/OfflineContext';
import { Button } from '@/components/ui/button';

function formatRelative(date: Date | null): string {
  if (!date) return 'never';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function OfflineBanner() {
  const { isOnline, isSlowConnection, pendingSyncCount, lastSyncTime, syncNow } = useOffline();

  if (isOnline && !isSlowConnection && pendingSyncCount === 0) {
    return null;
  }

  return (
    <>
      {!isOnline && (
        <div
          className="animate-fade-in bg-destructive/90 text-destructive-foreground px-4 py-2 flex items-center justify-center gap-2 text-sm"
        >
          <WifiOff className="h-4 w-4" />
          <span>
            You're offline · last synced {formatRelative(lastSyncTime)}
          </span>
        </div>
      )}

      {isOnline && isSlowConnection && (
        <div
          className="animate-fade-in bg-yellow-500/90 text-yellow-950 px-4 py-2 flex items-center justify-center gap-2 text-sm"
        >
          <CloudOff className="h-4 w-4" />
          <span>Slow connection - using cached data when possible</span>
        </div>
      )}

      {isOnline && pendingSyncCount > 0 && (
        <div
          className="animate-fade-in bg-primary/90 text-primary-foreground px-4 py-2 flex items-center justify-center gap-2 text-sm"
        >
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>{pendingSyncCount} pending change{pendingSyncCount > 1 ? 's' : ''} to sync</span>
          <Button 
            size="sm" 
            variant="secondary" 
            className="h-6 px-2 text-xs ml-2"
            onClick={syncNow}
          >
            Sync Now
          </Button>
        </div>
      )}
    </>
  );
}
