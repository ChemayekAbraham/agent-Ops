import { useEffect, useState, useCallback } from 'react';
import { ArrowRight, CloudUpload, WifiOff } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { getEntries, getQueuedEntries } from '@/lib/fieldCollectStore';
import { formatUGX } from '@/lib/rentCalculations';

interface FieldCollectCardProps {
  onOpen: () => void;
}

/**
 * Calm, Apple-style entry card for Field Collect.
 *
 * Hierarchy: huge Today amount (or one-line CTA) → tiny status footnote →
 * single chevron affordance. Status badges only show when they need action
 * (offline / pending sync). All visual weight goes to the number.
 */
export function FieldCollectCard({ onOpen }: FieldCollectCardProps) {
  const { user } = useAuth();
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    try {
      const [all, queued] = await Promise.all([
        getEntries(user.id),
        getQueuedEntries(user.id),
      ]);
      setTotal(all.reduce((s, e) => s + Number(e.amount || 0), 0));
      setPending(queued.length);
    } catch { /* ignore */ }
  }, [user?.id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [refresh]);

  const hasActivity = total > 0 || pending > 0;
  const needsAttention = !online || pending > 0;

  return (
    <button
      onClick={onOpen}
      aria-label="Open Field Collect to record a cash payment"
      className="w-full text-left rounded-3xl border bg-card hover:bg-accent/40 active:bg-accent/60 active:scale-[0.99] transition-all touch-manipulation flex items-center gap-4 min-h-[104px] sm:min-h-[96px] px-5 sm:px-6 py-4"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          {hasActivity ? 'Collected today' : 'Field Collect'}
        </p>
        {hasActivity ? (
          <p className="text-[32px] sm:text-[28px] font-bold tabular-nums leading-tight tracking-tight mt-0.5">
            {formatUGX(total)}
          </p>
        ) : (
          <p className="text-lg sm:text-base font-semibold mt-0.5">Tap to record cash</p>
        )}
        {needsAttention && (
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
            {!online && (
              <span className="inline-flex items-center gap-1">
                <WifiOff className="h-3 w-3" />
                Offline
              </span>
            )}
            {pending > 0 && (
              <span className="inline-flex items-center gap-1">
                <CloudUpload className="h-3 w-3" />
                {pending} to send
              </span>
            )}
          </div>
        )}
      </div>
      <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
    </button>
  );
}

export default FieldCollectCard;