import { useCallback } from 'react';
import { toast } from 'sonner';
import { isListingDaytime, LISTING_HOURS_LABEL, LISTING_NIGHT_MESSAGE } from '@/lib/listingHours';
import { hapticTap } from '@/lib/haptics';

/**
 * Returns a guard function that allows house-listing actions only during the
 * daytime window (6:00 AM – 6:00 PM EAT). At night it shows a clear warning
 * toast and prevents the listing dialog from opening.
 */
export function useListingDaytimeGuard() {
  return useCallback(() => {
    if (isListingDaytime()) return true;

    hapticTap();
    toast.warning('Listing is closed for the night', {
      description: `${LISTING_NIGHT_MESSAGE} (${LISTING_HOURS_LABEL})`,
      duration: 6000,
    });
    return false;
  }, []);
}
