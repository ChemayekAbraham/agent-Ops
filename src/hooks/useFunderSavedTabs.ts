import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAuthenticatedAudience } from '@/hooks/useAuthenticatedPoll';
import { useMyCoSupportInvites } from '@/hooks/useCoSupport';
import { useFunderBookedHouses } from '@/hooks/useFunderBookedHouses';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';
import {
  coSupportTabRows,
  defaultFunderSavedTab,
  floatHoldBreakdown,
  floatHoldLine,
  funderSavedCounts,
  funderSavedTotal,
  type FunderSavedTab,
} from '@/lib/funderSavedTabs';

/**
 * Data for the Saved Items pills (Co-support / Bookmarked / Booked). Read-only: every row
 * comes from an existing caller-checked RPC (co_support_my_invites, funder_booked_houses) or
 * this device's bookmarks. Actions on a row keep using the hooks the rows already use
 * (useCancelCoSupport, useFundCoSupportAlone, useReinviteCoSupport, fund/releaseBookedHouse).
 */
export function useFunderSavedTabs(enabled = true, requestedTab?: FunderSavedTab | null) {
  const invites = useMyCoSupportInvites(enabled);
  const booked = useFunderBookedHouses(enabled);
  const { count: bookmarked } = useFunderSavedItems();
  const now = Date.now();
  const counts = funderSavedCounts({ invites: invites.data, bookmarked, bookedHeld: booked.heldCount, now });
  return {
    counts,
    total: funderSavedTotal(counts),
    initialTab: defaultFunderSavedTab(counts, requestedTab),
    coSupportRows: coSupportTabRows(invites.data, now),
    coSupportLoading: invites.isLoading,
    coSupportError: invites.error,
    bookings: booked.bookings,
    bookingsLoading: booked.query.isLoading,
  };
}

/**
 * Why "Available operational float" is lower than the float in the wallet.
 * `line` is the sentence to show under the figure (null when nothing is held);
 * a co-support hold should link to Saved Items opened on the Co-support pill.
 */
export function useFunderFloatHolds(enabled = true) {
  const { user } = useAuth();
  const ready = useAuthenticatedAudience();
  const invites = useMyCoSupportInvites(enabled && !!user);
  const figures = useQuery({
    queryKey: ['funder-float-holds', user?.id],
    enabled: enabled && ready && !!user,
    staleTime: 15_000,
    queryFn: async () => {
      const [bal, cap] = await Promise.all([
        supabase.rpc('get_user_float_available_balance', { p_user_id: user!.id }),
        supabase.rpc('funder_support_capacity', { p_user_id: user!.id }),
      ]);
      if (bal.error) throw bal.error;
      if (cap.error) throw cap.error;
      return { floatBalance: Number(bal.data ?? 0), available: Number(cap.data ?? 0) };
    },
  });
  const breakdown = figures.data
    ? floatHoldBreakdown({ ...figures.data, invites: invites.data })
    : null;
  return {
    breakdown,
    line: breakdown ? floatHoldLine(breakdown) : null,
    /** Open Saved Items on this pill when the partner taps the hold line. */
    tab: (breakdown?.coSupportHeld ?? 0) > 0 ? ('co_support' as const) : null,
    isLoading: figures.isLoading || invites.isLoading,
    error: figures.error ?? invites.error ?? null,
  };
}
