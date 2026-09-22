import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewMarketSummary } from './types';
import { compactParts } from './utils';

/**
 * Compact market-demand hero for /dashboard/funder-new.
 *
 * Market-wide figures only: the total, the count and the average all describe
 * the same eligible unfunded empty-house set, and none of them react to the
 * viewer's location, filters, saves or selection. The full explanation lives in
 * the How it works dialog so the first impression stays quiet.
 */
export function FunderNewHero({
  summary,
  isLoading,
  hasError,
  onHowItWorks,
}: {
  summary: FunderNewMarketSummary | undefined;
  isLoading: boolean;
  hasError: boolean;
  onHowItWorks: () => void;
}) {
  const shell =
    'relative overflow-hidden rounded-3xl bg-primary px-5 py-5 text-primary-foreground shadow-md sm:px-7 sm:py-6';

  const decoration = (
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70">
      <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary-foreground/10 blur-2xl" />
      <div className="absolute -bottom-24 left-1/3 h-48 w-48 rounded-full bg-primary-foreground/[0.07] blur-2xl" />
    </div>
  );

  if (isLoading) {
    return (
      <section className={shell} aria-busy="true">
        {decoration}
        <div className="relative space-y-3">
          <Skeleton className="h-4 w-44 bg-primary-foreground/20" />
          <Skeleton className="h-11 w-52 bg-primary-foreground/20 sm:h-14 sm:w-64" />
          <Skeleton className="h-4 w-60 bg-primary-foreground/20" />
        </div>
      </section>
    );
  }

  if (hasError || !summary) {
    return (
      <section className={shell}>
        {decoration}
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight sm:text-lg">Homes waiting for support</h1>
            <p className="mt-1.5 text-sm text-primary-foreground/90">
              The live market total is unavailable right now. Homes below still load, so you can keep browsing.
            </p>
          </div>
          <Button
            variant="ghost"
            onClick={onHowItWorks}
            className="h-11 w-fit shrink-0 rounded-full px-4 text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"
          >
            <HelpCircle className="h-4 w-4" aria-hidden />
            How it works
          </Button>
        </div>
      </section>
    );
  }

  const { prefix, figure } = compactParts(summary.totalRentNeeded);
  const hasHouses = summary.houseCount > 0;

  return (
    <section className={shell}>
      {decoration}
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight text-primary-foreground/85 sm:text-base">
            Homes waiting for support
          </h1>

          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 leading-none">
            <span className="text-base font-semibold text-primary-foreground/80 sm:text-lg">{prefix}</span>
            <span className="break-words text-[2.75rem] font-bold tracking-tight sm:text-5xl lg:text-[3.5rem]">
              {figure}
            </span>
          </p>

          <p className="mt-2 text-sm font-medium text-primary-foreground/90 sm:text-base">
            {summary.houseCount.toLocaleString()} {summary.houseCount === 1 ? 'home' : 'homes'}
            {hasHouses ? ` \u00b7 About ${formatDynamic(Math.round(summary.avgMonthlyRent))} per home` : ''}
          </p>
        </div>

        <Button
          variant="ghost"
          onClick={onHowItWorks}
          className="h-11 w-fit shrink-0 rounded-full px-4 text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"
        >
          <HelpCircle className="h-4 w-4" aria-hidden />
          How it works
        </Button>
      </div>
    </section>
  );
}

export default FunderNewHero;
