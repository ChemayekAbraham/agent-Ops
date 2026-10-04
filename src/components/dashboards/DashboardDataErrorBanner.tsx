import { useState } from 'react';
import { AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DashboardDataErrorBannerProps {
  /** Error message to show; banner is hidden when null/undefined. */
  message?: string | null;
  /** Retry handler — should refetch the failed data. */
  onRetry: () => void | Promise<void>;
  /** When true, the banner stays visible but its copy reflects cached data is shown. */
  hasCachedData?: boolean;
  className?: string;
}

/**
 * Non-blocking inline banner shown when dashboard data fails to load.
 * Ensures the dashboard never fails silently — the agent always sees that
 * something went wrong and gets a one-tap Retry instead of stale/empty zeros.
 */
export function DashboardDataErrorBanner({
  message,
  onRetry,
  hasCachedData = false,
  className,
}: DashboardDataErrorBannerProps) {
  const [retrying, setRetrying] = useState(false);

  if (!message) return null;

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      className={cn(
        'mx-3 mt-2 flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5',
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">
          {hasCachedData
            ? "Showing your last saved data — we couldn't refresh just now."
            : "We couldn't load your latest dashboard data."}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 break-words">
          {message}
        </p>
      </div>
      <button
        type="button"
        onClick={handleRetry}
        disabled={retrying}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-60 shrink-0"
      >
        {retrying ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}

export default DashboardDataErrorBanner;