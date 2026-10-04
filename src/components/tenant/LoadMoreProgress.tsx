import { Skeleton } from '@/components/ui/skeleton';

interface LoadMoreProgressProps {
  /** Rows already shown across all fetched pages. */
  loadedCount: number;
  /** Source pages fetched so far this run. */
  pagesFetched: number;
  /** Whether more pages remain to fetch. */
  hasMore: boolean;
  /** How many skeleton placeholder cards to render. Defaults to 2. */
  skeletonCount?: number;
  /** Tailwind height class for each skeleton card. */
  skeletonClassName?: string;
}

/**
 * Estimated progress for open-ended (unknown-total) pagination.
 *
 * We can't know the true total up front, so we ease a bar toward — but never
 * quite reaching — 100% while more pages remain, then snap to full when the
 * source is exhausted. Each fetched page contributes a shrinking increment, so
 * early pages move the bar a lot and later pages a little (feels responsive
 * without ever "completing" prematurely).
 */
function estimateProgress(pagesFetched: number, hasMore: boolean): number {
  if (!hasMore) return 100;
  const eased = 100 * (1 - Math.pow(0.7, Math.max(1, pagesFetched)));
  return Math.min(92, Math.max(8, Math.round(eased)));
}

export function LoadMoreProgress({
  loadedCount,
  pagesFetched,
  hasMore,
  skeletonCount = 2,
  skeletonClassName = 'h-40 w-full rounded-2xl',
}: LoadMoreProgressProps) {
  const pct = estimateProgress(pagesFetched, hasMore);

  return (
    <div className="space-y-3 pb-2" role="status" aria-live="polite">
      {/* Persistent skeleton cards so the incoming content has a visible shape. */}
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <Skeleton key={i} className={skeletonClassName} />
      ))}

      {/* Estimated progress bar + count. */}
      <div className="space-y-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full border-2 border-muted-foreground/40 border-t-transparent animate-spin" />
            Loading more houses…
          </span>
          <span className="tabular-nums">
            {loadedCount} loaded · ~{pct}%
          </span>
        </div>
      </div>
    </div>
  );
}
