import { ArrowRight } from 'lucide-react';
import { FadedHouseIllustration } from '@/components/common/FadedHouseIllustration';
import { formatDynamic, getDynamicCurrencySymbol } from '@/lib/currencyFormat';
import type { FunderNewMarketSummary } from '@/components/funder-new/types';
import '@/components/funder-new/FunderNewHero.css';

/**
 * Funder V3 market hero. Same figures and words as the live hero
 * (FunderNewHero): the market total in full, the house count, the 15% line.
 * The only addition is an explicit "See houses to fund" button, so the card no
 * longer relies on a whole-card tap people do not discover.
 */
export function FunderV3Hero({
  summary,
  isLoading,
  hasError,
  emptyHousesAllowed,
  onOpen,
  onIntent,
}: {
  summary: FunderNewMarketSummary | undefined;
  isLoading: boolean;
  hasError: boolean;
  /** From useFunderEmptyHousesAllowed(), passed in so this stays presentational. */
  emptyHousesAllowed: boolean;
  onOpen: () => void;
  onIntent?: () => void;
}) {
  const shell =
    'funder-hero-card relative isolate overflow-hidden rounded-3xl bg-primary px-5 py-5 text-primary-foreground shadow-md @[520px]:px-7 @[520px]:py-7';

  const decoration = (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-70">
      <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary-foreground/10 blur-2xl" />
      <div className="absolute -bottom-24 left-1/3 h-48 w-48 rounded-full bg-primary-foreground/[0.07] blur-2xl" />
      <FadedHouseIllustration opacity={0.22} />
    </div>
  );

  const cta = (
    <button
      type="button"
      data-testid="fv3-hero-cta"
      onClick={onOpen}
      onPointerEnter={onIntent}
      onPointerDown={onIntent}
      onFocus={onIntent}
      // Content width, left aligned: the right edge stays clear of the assistant launcher on phones.
      className="fv3-tap mt-5 inline-flex h-12 w-auto max-w-full items-center justify-center gap-2 rounded-2xl bg-primary-foreground px-5 fv3-t-base font-bold text-primary shadow-sm transition-transform hover:bg-primary-foreground/95 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
    >
      See houses to fund
      <ArrowRight className="h-4 w-4" aria-hidden />
    </button>
  );

  if (isLoading) {
    return (
      <section className={shell} aria-busy="true" data-testid="fv3-hero">
        {decoration}
        <div className="space-y-3">
          <div className="h-4 w-44 rounded bg-primary-foreground/20" />
          <div className="h-11 w-52 rounded bg-primary-foreground/20" />
          <div className="h-4 w-60 rounded bg-primary-foreground/20" />
        </div>
        {cta}
      </section>
    );
  }

  if (emptyHousesAllowed && (hasError || !summary)) {
    return (
      <section className={shell} data-testid="fv3-hero">
        {decoration}
        <h1 className="fv3-t-lg font-semibold tracking-tight">Homes waiting for support</h1>
        <p className="mt-1.5 fv3-t-sm text-primary-foreground/90">
          The live market total is unavailable right now. Homes below still load, so you can keep browsing.
        </p>
        {cta}
      </section>
    );
  }

  // Same formatting as the live hero: full, unabbreviated total with the small
  // currency prefix kept apart from the digits.
  const prefix = getDynamicCurrencySymbol();
  const formattedTotal = formatDynamic(summary?.totalRentNeeded ?? 0);
  const figure = formattedTotal.replace(prefix, '').replace(/^[^\d.,-]+/, '').trim() || formattedTotal;

  return (
    <section className={shell} data-testid="fv3-hero">
      {decoration}
      <div className="flex flex-col gap-4 @[640px]:flex-row @[640px]:items-end @[640px]:justify-between">
        <h1 className="funder-hero-heading min-w-0">
          <span><span className="text-[1.15em] leading-none">Earn</span> monthly</span>
          <span><span className="text-green-300">15%</span> of your</span>
          <span>money</span>
          <span className="funder-hero-accent">when you pay a</span>
          <span className="funder-hero-accent">tenant&apos;s rent</span>
        </h1>

        {emptyHousesAllowed && summary ? (
          <div className="text-right @[640px]:pb-1">
            <p className="funder-hero-subtle fv3-t-xs font-bold">Amount needed to fund houses:</p>
            <p data-testid="fv3-hero-total" className="mt-0.5 break-words text-[1.5em] font-black leading-tight text-green-300">
              {prefix} {figure}
            </p>
            <p data-testid="fv3-hero-count" className="funder-hero-subtle mt-0.5 fv3-t-2xs font-bold leading-snug">
              over {summary.houseCount.toLocaleString()}+ homes
            </p>
          </div>
        ) : null}
      </div>
      {cta}
    </section>
  );
}

export default FunderV3Hero;
