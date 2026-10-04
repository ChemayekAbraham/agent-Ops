import { WifiOff, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface OfflineBannerProps {
  lastSyncTime?: string | null;
  compact?: boolean;
}

export default function OfflineBanner({ lastSyncTime, compact = false }: OfflineBannerProps) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-xs">
        <WifiOff className="h-3 w-3" />
        <span>Offline - Viewing cached messages</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-sm">
      <div className="flex items-center gap-2">
        <WifiOff className="h-4 w-4" />
        <span>You're offline</span>
      </div>
      {lastSyncTime && (
        <div className="flex items-center gap-1 text-xs opacity-75">
          <Clock className="h-3 w-3" />
          <span>Synced {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}</span>
        </div>
      )}
    </div>
  );
}
