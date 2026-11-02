import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic, getDynamicCurrencySymbol } from '@/lib/currencyFormat';
import type { FunderNewMarketSummary } from './types';

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
        </div>
      </section>
    );
  }

  // Full, unabbreviated market total: keep the small currency prefix, but show
  // every digit instead of a compact "5.8B".
  const prefix = getDynamicCurrencySymbol();
  const formattedTotal = formatDynamic(summary.totalRentNeeded);
  const figure = formattedTotal.replace(prefix, '').replace(/^[^\d.,-]+/, '').trim() || formattedTotal;
  const hasHouses = summary.houseCount > 0;

  return (
    <section className={shell}>
      {decoration}
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] font-black leading-[1.2] tracking-tight sm:text-4xl lg:text-5xl">
            <span className="block">Earn 15% of your</span>
            <span className="block">money monthly</span>
            <span className="block text-[hsl(var(--signature-rent-accent))]">when you pay a</span>
            <span className="block text-[hsl(var(--signature-rent-accent))]">tenant&apos;s rent</span>
          </h1>

          <div className="mt-5">
            <p className="text-xs font-bold text-[hsl(var(--signature-rent-subtle))]">
              Amount needed to fund houses:
            </p>
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 leading-tight">
              <span className="text-sm font-bold text-[hsl(var(--signature-rent-subtle))]">{prefix}</span>
              <span className="break-words text-xl font-black tracking-tight sm:text-2xl">{figure}</span>
            </p>
            <p className="mt-0.5 text-[11px] font-bold leading-snug text-[hsl(var(--signature-rent-subtle))]">
              over {summary.houseCount.toLocaleString()}+ homes
            </p>
          </div>
        </div>

      </div>
    </section>
  );
}

export default FunderNewHero;
