import { Button } from '@/components/ui/button';

export function PortfolioSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
        <div className="h-3 w-32 rounded bg-muted animate-pulse" />
        <div className="h-7 w-40 rounded bg-muted animate-pulse" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-8 rounded bg-muted animate-pulse" />
          <div className="h-8 rounded bg-muted animate-pulse" />
        </div>
      </div>
      <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
        <div className="h-3 w-24 rounded bg-muted animate-pulse" />
        <div className="h-6 w-36 rounded bg-muted animate-pulse" />
        <div className="h-1.5 rounded-full bg-muted animate-pulse" />
        <div className="h-10 rounded-xl bg-muted animate-pulse" />
      </div>
    </div>
  );
}

export function PortfolioEmptyState({ onExplore }: { onExplore: () => void }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-2">
      <p className="text-sm font-bold text-foreground">No active portfolios</p>
      <p className="text-[11px] text-muted-foreground">You currently have no capital deployed.</p>
      <Button size="sm" className="mt-1 w-full text-white" onClick={onExplore}>Explore Capital Opportunities</Button>
    </div>
  );
}

export function PortfolioErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-destructive/40 bg-card p-4 space-y-2">
      <p className="text-sm font-bold text-foreground">We couldn't load your portfolios.</p>
      <Button size="sm" variant="outline" className="mt-1" onClick={onRetry}>Try again</Button>
    </div>
  );
}
