import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

function formatRelative(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return 'never';
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Small "Last updated · Xs ago · Refresh" chip so operators can confirm
 * a widget's data is truly current. Ticks every 15s so the relative
 * label stays honest between fetches.
 */
export function LastUpdatedChip({
  updatedAt,
  onRefresh,
  isFetching,
  className = '',
}: {
  updatedAt: number;
  onRefresh?: () => void;
  isFetching?: boolean;
  className?: string;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const absolute = updatedAt
    ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  return (
    <div
      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground ${className}`}
      title={`Data timestamp: ${absolute}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isFetching ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'
        }`}
        aria-hidden
      />
      <span>
        Last updated <span className="tabular-nums">{formatRelative(updatedAt)}</span>
      </span>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50 text-[10px] font-semibold text-foreground"
          title="Refresh now"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      )}
    </div>
  );
}

export default LastUpdatedChip;