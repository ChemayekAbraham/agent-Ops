import { Skeleton } from '@/components/ui/skeleton';

/**
 * Lightweight, section-level skeleton placeholders used by dashboards while
 * their per-section data is loading. Designed to match the *layout* of the
 * real component so the page never visually jumps when real data lands.
 *
 * All animations are short (~250ms fade) and respect the existing shimmer
 * primitive in `Skeleton`. No layout shift, no spinners.
 */

/** Top bar with avatar + name + trailing icon (matches DashboardHeader). */
export function TopBarSkeleton() {
  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/60"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
    </div>
  );
}

/** Vertical sidebar with 6 stacked nav items (matches Executive layout). */
export function SidebarSkeleton() {
  return (
    <aside
      className="hidden lg:flex flex-col w-60 shrink-0 border-r border-border bg-card/40 p-3 gap-1"
    >
      <Skeleton className="h-3 w-16 mb-2 ml-2" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      ))}
    </aside>
  );
}

/** Hero wallet/balance card placeholder. */
export function WalletHeroSkeleton() {
  return (
    <div
      className="rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/20 p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-24 bg-foreground/10" />
        <Skeleton className="h-8 w-8 rounded-lg bg-foreground/10" />
      </div>
      <Skeleton className="h-9 w-44 bg-foreground/15" />
      <div className="grid grid-cols-3 gap-2 pt-1">
        <div className="space-y-1.5">
          <Skeleton className="h-2.5 w-12 bg-foreground/10" />
          <Skeleton className="h-4 w-16 bg-foreground/15" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-2.5 w-12 bg-foreground/10" />
          <Skeleton className="h-4 w-16 bg-foreground/15" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-2.5 w-12 bg-foreground/10" />
          <Skeleton className="h-4 w-16 bg-foreground/15" />
        </div>
      </div>
    </div>
  );
}

/** Row of compact metric/stat cards. */
export function MetricRowSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div
      className={`grid gap-3 ${count >= 4 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2 md:grid-cols-3'}`}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-card p-3 space-y-2"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-2.5 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Section heading + bullet list (rent requests, sub-agents, referrals…). */
export function ListSectionSkeleton({
  title = true,
  rows = 3,
}: { title?: boolean; rows?: number }) {
  return (
    <div className="space-y-3">
      {title && (
        <div className="flex items-center gap-2 px-1">
          <div className="w-1 h-5 rounded-full bg-muted" />
          <Skeleton className="h-3.5 w-32" />
        </div>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/60"
        >
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Chart placeholder with title + bar shimmer. */
export function ChartSkeleton({ height = 160 }: { height?: number }) {
  return (
    <div
      className="rounded-xl border border-border bg-card p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="w-full" style={{ height }} />
    </div>
  );
}

/** Simple table placeholder (header row + N body rows). */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div
      className="rounded-xl border border-border bg-card overflow-hidden"
    >
      <div
        className="grid gap-3 px-4 py-3 border-b border-border bg-muted/20"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-3/4" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="grid gap-3 px-4 py-3 border-b border-border/40 last:border-b-0"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-3.5 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Generic widget card (used for opportunities, capital, recent activity…). */
export function WidgetCardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div
      className="rounded-xl border border-border bg-card p-4 space-y-3"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-2.5 w-1/3" />
        </div>
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3 w-full" />
      ))}
      <div className="flex gap-2 pt-1">
        <Skeleton className="h-8 flex-1 rounded-lg" />
        <Skeleton className="h-8 w-20 rounded-lg" />
      </div>
    </div>
  );
}
