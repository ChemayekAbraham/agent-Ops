import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ThreeBodyLoader from '@/components/common/ThreeBodyLoader';

interface StalledLoaderWatchdogProps {
  /** ms before showing the recovery UI. Default 15000. */
  stallAfterMs?: number;
  /** Optional label under the spinner. */
  label?: string;
  /** Optional className for the outer container. */
  className?: string;
}

async function clearSiteCaches() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  // Preserve auth tokens on plain reload; only wipe cache-related keys.
  try {
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith('welile-cache') ||
        key.startsWith('rq-cache') ||
        key.startsWith('chunk_') ||
        key.startsWith('vite-') ||
        key.startsWith('welile-live-rates')
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Renders a spinner and, if loading exceeds `stallAfterMs` (default 15s),
 * surfaces a recovery panel with Reload and Clear cache options so users
 * on flaky networks or stale bundles are never stranded on a spinner.
 */
export default function StalledLoaderWatchdog({
  stallAfterMs = 15000,
  label,
  className,
}: StalledLoaderWatchdogProps) {
  const [stalled, setStalled] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setStalled(true), stallAfterMs);
    return () => window.clearTimeout(t);
  }, [stallAfterMs]);

  const handleReload = () => {
    try {
      sessionStorage.removeItem('chunk_retry');
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  const handleClearCache = async () => {
    setClearing(true);
    await clearSiteCaches();
    window.location.reload();
  };

  return (
    <div
      className={
        className ??
        'min-h-screen flex flex-col items-center justify-center bg-background gap-4 px-6'
      }
    >
      <ThreeBodyLoader />
      {label && !stalled && (
        <p className="text-sm text-muted-foreground">{label}</p>
      )}

      {stalled && (
        <div className="max-w-sm w-full text-center space-y-3 mt-2">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">
              Taking longer than usual
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Your connection may be slow, or the app may be running an old
              version. Try reloading, or clear the cache if it keeps happening.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button onClick={handleReload} className="gap-2" style={{ minHeight: 44 }}>
              <RefreshCw className="h-4 w-4" />
              Reload
            </Button>
            <Button
              variant="outline"
              onClick={handleClearCache}
              disabled={clearing}
              className="gap-2"
              style={{ minHeight: 44 }}
            >
              {clearing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Clear cache & reload
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}