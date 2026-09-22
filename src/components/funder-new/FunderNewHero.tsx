import { AlertTriangle, HelpCircle, Home, MapPin, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatDynamic, formatDynamicCompact } from '@/lib/currencyFormat';
import type { FunderNewMarketSummary } from './types';

/**
 * Market-demand hero for the /dashboard/funder-new review route.
 * Market-wide information only — never wallet or profile figures.
 */
export function FunderNewHero({
  summary,
  isLoading,
  hasError,
  onExploreMap,
  onHowItWorks,
}: {
  summary: FunderNewMarketSummary | undefined;
  isLoading: boolean;
  hasError: boolean;
  onExploreMap: () => void;
  onHowItWorks: () => void;
}) {
  if (isLoading) {
    return (
      <section className="overflow-hidden rounded-3xl border bg-card p-6 shadow-sm sm:p-8">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-14 w-64 sm:h-20 sm:w-80" />
        <Skeleton className="mt-4 h-4 w-full max-w-md" />
        <Skeleton className="mt-2 h-4 w-full max-w-sm" />
        <div className="mt-6 flex gap-3">
          <Skeleton className="h-11 w-36 rounded-full" />
          <Skeleton className="h-11 w-36 rounded-full" />
        </div>
      </section>
    );
  }

  if (hasError || !summary) {
    return (
      <Alert variant="warning" className="rounded-3xl border-warning/40 bg-warning/10 p-6">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Market demand unavailable</AlertTitle>
        <AlertDescription>
          The live totals could not be loaded right now, so nothing is being shown as zero. Homes below still load
          independently — you can keep browsing.
        </AlertDescription>
      </Alert>
    );
  }

  const hasHouses = summary.houseCount > 0;

  return (
    <section className="relative overflow-hidden rounded-3xl border border-primary/20 bg-primary text-primary-foreground shadow-lg">
      {/* Soft layered pattern — decorative only */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-60">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-primary-foreground/10 blur-2xl" />
        <div className="absolute -bottom-28 -left-16 h-72 w-72 rounded-full bg-primary-foreground/10 blur-2xl" />
      </div>

      <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.35fr_1fr] lg:items-center lg:p-10">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            <Sparkles className="h-3.5 w-3.5" /> Live market demand
          </p>

          <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Homes waiting for support</h1>

          <p className="mt-3 text-5xl font-bold leading-none tracking-tight sm:text-6xl lg:text-7xl">
            {formatDynamicCompact(summary.totalRentNeeded)}
          </p>
          <p className="mt-2 text-sm font-medium text-primary-foreground/80">{formatDynamic(summary.totalRentNeeded)}</p>

          <p className="mt-5 max-w-xl text-base font-medium sm:text-lg">
            {summary.houseCount.toLocaleString()} empty {summary.houseCount === 1 ? 'house is' : 'houses are'} waiting
            for a Supporter
            {hasHouses ? ` · about ${formatDynamic(Math.round(summary.avgMonthlyRent))} per house` : ''}
          </p>

          <p className="mt-3 max-w-xl text-sm leading-relaxed text-primary-foreground/80">
            This is all the rent money still needed to put tenants into every empty house. It goes up when agents list
            new empty houses, and down when Supporters fund them.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              size="lg"
              onClick={onExploreMap}
              className="h-12 rounded-full bg-primary-foreground px-6 text-primary hover:bg-primary-foreground/90"
            >
              <MapPin className="h-4 w-4" />
              Explore map
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={onHowItWorks}
              className="h-12 rounded-full border-primary-foreground/40 bg-transparent px-6 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
            >
              <HelpCircle className="h-4 w-4" />
              How it works
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div className="rounded-2xl bg-primary-foreground/10 p-4 backdrop-blur-sm">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary-foreground/70">
              <Home className="h-3.5 w-3.5" /> Empty houses
            </p>
            <p className="mt-2 text-3xl font-semibold">{summary.houseCount.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl bg-primary-foreground/10 p-4 backdrop-blur-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary-foreground/70">
              Average per house
            </p>
            <p className="mt-2 text-2xl font-semibold">
              {hasHouses ? formatDynamic(Math.round(summary.avgMonthlyRent)) : 'No houses listed'}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default FunderNewHero;
