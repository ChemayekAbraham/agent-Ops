import type { KeyboardEvent } from 'react';
import { FadedHouseIllustration } from '@/components/common/FadedHouseIllustration';
import { ArrowUpRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic, getDynamicCurrencySymbol } from '@/lib/currencyFormat';
import type { FunderNewMarketSummary } from './types';
import './FunderNewHero.css';

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
  onOpen,
  onIntent,
}: {
  summary: FunderNewMarketSummary | undefined;
  isLoading: boolean;
  hasError: boolean;
  onHowItWorks: () => void;
  /** When set, the whole card is a button (the dashboard opens the full screen map). */
  onOpen?: () => void;
  /** Fired when a finger or pointer reaches the card, before the tap lands (to preload what it opens). */
  onIntent?: () => void;
}) {
  const shell =
    'relative overflow-hidden rounded-3xl bg-primary px-5 py-5 text-primary-foreground shadow-md sm:px-7 sm:py-6';

  const decoration = (
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70">
      <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary-foreground/10 blur-2xl" />
      <div className="absolute -bottom-24 left-1/3 h-48 w-48 rounded-full bg-primary-foreground/[0.07] blur-2xl" />
      {/* The house, very faint, behind the text */}
      <FadedHouseIllustration opacity={0.22} />
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
    <section
      className={`${shell} funder-hero-card${onOpen ? ' cursor-pointer transition-transform active:scale-[0.99]' : ''}`}
      {...(onOpen
        ? {
            role: 'button' as const,
            tabIndex: 0,
            'aria-label': 'Open the map of houses to fund',
            onClick: onOpen,
            onPointerEnter: onIntent,
            onPointerDown: onIntent,
            onTouchStart: onIntent,
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      {decoration}
      {onOpen && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-primary-foreground/15 text-primary-foreground sm:right-5 sm:top-5"
        >
          <ArrowUpRight className="h-4 w-4" />
        </span>
      )}
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="funder-hero-heading">
            <span><span className="text-[1.15em] leading-none">Earn</span> monthly</span>
            <span><span className="text-green-300">15%</span> of your</span>
            <span>money</span>
            <span className="funder-hero-accent">when you pay a</span>
            <span className="funder-hero-accent">tenant&apos;s rent</span>
          </h1>

          <div className="mt-5 text-right">
            <p className="funder-hero-subtle text-xs font-bold">Amount needed to fund houses:</p>
            <p className="mt-0.5 break-words text-[22px] font-black leading-tight text-green-300">
              {prefix} {figure}
            </p>
            <p className="funder-hero-subtle mt-0.5 text-[11px] font-bold leading-snug">
              over {summary.houseCount.toLocaleString()}+ homes
            </p>
          </div>
        </div>

      </div>
    </section>
  );
}

export default FunderNewHero;
