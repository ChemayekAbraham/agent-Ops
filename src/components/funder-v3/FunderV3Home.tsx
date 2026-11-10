import type { ReactNode } from 'react';
import { Wallet } from 'lucide-react';
import type { FunderNewMarketSummary } from '@/components/funder-new/types';
import { FunderV3Hero } from './FunderV3Hero';
import './funderV3.css';

export interface FunderV3HomeProps {
  /** Avatar + profile popover (live: ProfileSummaryPopover). */
  avatar: ReactNode;
  /** AI ID chip (live: AiIdButton). */
  aiId?: ReactNode;
  firstName: string;
  locationLabel: string;
  /** Market summary figures, already formatted exactly as the live profile card shows them. */
  openHouses: number;
  avgRentLabel: string | null;
  onViewPortfolio: () => void;
  summary: FunderNewMarketSummary | undefined;
  summaryLoading: boolean;
  summaryError: boolean;
  emptyHousesAllowed: boolean;
  onOpenHouses: () => void;
  onIntent?: () => void;
  /** Extra content under the cards (e.g. the approval banner). */
  footer?: ReactNode;
}

/**
 * Funder V3 home. Phones: profile card, then the hero, stacked. From 1024px:
 * a 12-column grid (profile and portfolio left, hero right), capped at 1280px.
 * Presentation only; every figure arrives as a prop from the live hooks.
 */
export function FunderV3Home({
  avatar,
  aiId,
  firstName,
  locationLabel,
  openHouses,
  avgRentLabel,
  onViewPortfolio,
  summary,
  summaryLoading,
  summaryError,
  emptyHousesAllowed,
  onOpenHouses,
  onIntent,
  footer,
}: FunderV3HomeProps) {
  return (
    <div className="fv3 @container w-full" data-testid="fv3-home">
      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-3 px-4 py-4 @2xl:gap-5 @2xl:px-6 @2xl:py-6 @5xl:grid-cols-12 @5xl:gap-6 @5xl:px-8">
        <div className="flex min-w-0 flex-col gap-3 @5xl:col-span-5 @5xl:gap-5">
          <section className="rounded-3xl border border-border/50 bg-card p-5 text-card-foreground shadow-[0_2px_16px_hsl(var(--foreground)/0.06)] @2xl:p-6" aria-label="Your profile">
            <div className="flex items-start gap-4">
              <div className="flex flex-col items-center text-center">
                {avatar}
                <h2 className="mt-2 fv3-t-lg font-bold leading-tight">{firstName}</h2>
                <p className="fv3-t-2xs font-medium text-muted-foreground">{locationLabel}</p>
              </div>
              <div className="flex min-w-0 flex-1 flex-col items-end justify-between gap-3 self-stretch">
                {aiId}
                <button
                  type="button"
                  onClick={onViewPortfolio}
                  className="fv3-tap inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 fv3-t-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <Wallet className="h-4 w-4" aria-hidden />
                  View portfolio
                </button>
              </div>
            </div>
            <p data-testid="fv3-home-summary" className="mt-4 border-t border-border/50 pt-3 fv3-t-xs font-medium leading-snug text-muted-foreground">
              {summaryLoading ? (
                <span aria-busy>Houses waiting …</span>
              ) : (
                <>
                  <span className="font-bold text-green-600 dark:text-green-400">{openHouses.toLocaleString()}</span> {openHouses === 1 ? 'house' : 'houses'} waiting
                  {avgRentLabel ? <> · avg <span className="font-bold text-foreground">{avgRentLabel}</span>/mo</> : null}
                </>
              )}
            </p>
          </section>
          {footer}
        </div>

        <div className="@container min-w-0 @5xl:col-span-7">
          <FunderV3Hero
            summary={summary}
            isLoading={summaryLoading}
            hasError={summaryError}
            emptyHousesAllowed={emptyHousesAllowed}
            onOpen={onOpenHouses}
            onIntent={onIntent}
          />
        </div>
      </div>
    </div>
  );
}

export default FunderV3Home;
