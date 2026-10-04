import { ShieldCheck } from 'lucide-react';
import { HouseListingCounts } from '@/hooks/useHouseListings';

interface HouseListingCountProps {
  counts: HouseListingCounts;
  /** Loaded rows currently rendered — used as a graceful fallback while counting. */
  loadedCount: number;
  /** Human label for the active location filter, e.g. "in Kampala". */
  locationLabel?: string;
  /** Extra trailing text (e.g. sort label). */
  suffix?: string;
  className?: string;
}

const fmt = (n: number) => n.toLocaleString();

/**
 * Shows the EXACT number of listed houses for the active filter — split into
 * verified (live in the marketplace) and not-yet-verified (pending approval) —
 * instead of the misleading "24+" that only counted loaded rows.
 */
export function HouseListingCount({
  counts,
  loadedCount,
  locationLabel,
  suffix,
  className,
}: HouseListingCountProps) {
  const { verified, unverified, total, loading, error } = counts;

  // While the exact count resolves (or if it errors), fall back to the loaded
  // count so the user always sees a sensible number.
  if (loading || error) {
    return (
      <p className={className}>
        {fmt(loadedCount)} house{loadedCount !== 1 ? 's' : ''}
        {locationLabel ? ` ${locationLabel}` : ''}
        {suffix ? ` · ${suffix}` : ''}
      </p>
    );
  }

  const where = locationLabel ? ` ${locationLabel}` : '';

  return (
    <div className={className} data-testid="house-listing-count">
      <span className="font-semibold text-foreground" data-testid="house-count-total">
        {fmt(total)}
      </span>{' '}
      house{total !== 1 ? 's' : ''} listed{where}
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 ml-1 align-middle">
        <span
          className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
          data-testid="house-count-verified"
          data-count={verified}
        >
          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
          {fmt(verified)} verified
        </span>
      </span>
      {suffix ? <span className="text-muted-foreground"> · {suffix}</span> : null}
    </div>
  );
}
