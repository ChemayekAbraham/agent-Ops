import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** One empty house this Supporter booked through a promissory note (funder_booked_houses). */
export interface FunderBooking {
  intent_id: string;
  note_id: string;
  house_id: string;
  title: string;
  district: string;
  image_urls: string[];
  verified: boolean;
  monthly_rent: number;
  status: 'reserved' | 'funded' | 'released' | string;
  promised_funding_date: string | null;
  reserved_until: string | null;
  released_at: string | null;
  release_reason: string | null;
  funded_at: string | null;
  days_left: number | null;
  created_at: string;
}

/** Server floor for house support (partner_support_houses raises below it). */
export const BOOKED_HOUSES_MIN_FUNDING = 50_000;

const KEY = 'funder-booked-houses';

/**
 * The Supporter's own house bookings: held (7-day hold), funding submitted,
 * and released. Read-only; funding and releasing go through the RPCs below.
 */
export function useFunderBookedHouses(enabled = true) {
  const { user } = useAuth();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [KEY, user?.id],
    enabled: enabled && !!user,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('funder_booked_houses');
      if (error) throw error;
      const payload = (data ?? {}) as { bookings?: FunderBooking[] };
      return Array.isArray(payload.bookings) ? payload.bookings : [];
    },
  });

  useEffect(() => {
    const refresh = () => void client.invalidateQueries({ queryKey: [KEY] });
    window.addEventListener('supporter-contribution-changed', refresh);
    return () => window.removeEventListener('supporter-contribution-changed', refresh);
  }, [client]);

  const bookings = query.data ?? [];
  const held = bookings.filter((b) => b.status === 'reserved');
  return { query, bookings, held, heldCount: held.length };
}

function describe(raw: string): string {
  if (raw.includes('AGREEMENT_REQUIRED')) return 'Sign your partnership agreement first, then try again.';
  if (raw.includes('BOOKING_NOT_FOUND')) return 'Some of these holds are no longer active. Refresh and try again.';
  if (raw.includes('HOUSES_UNAVAILABLE')) return 'Some of these houses are no longer available.';
  if (raw.includes('PARTNER_FUNDS_SHORT')) return 'Your support balance does not cover these houses. Top up and try again.';
  if (raw.includes('Minimum funding')) return raw.replace(/^.*?(Minimum funding)/, '$1');
  return raw;
}

/** Funds held houses together, so their total can reach the house minimum. */
export async function fundBookedHouses(held: FunderBooking[]) {
  const ids = held.map((b) => b.house_id);
  const intents = held.map((b) => b.intent_id).sort();
  const { error } = await supabase.rpc('funder_fund_booked_houses', {
    p_house_ids: ids,
    p_idempotency_key: `fund-${intents.join('.')}`,
  });
  if (error) throw new Error(describe(String(error.message || 'Could not fund these houses')));
  for (const noteId of new Set(held.map((b) => b.note_id))) {
    void supabase.functions.invoke('notify-house-booking', { body: { note_id: noteId } }).catch(() => {});
  }
  window.dispatchEvent(new Event('supporter-contribution-changed'));
}

/** Gives a held house back to the open list for other Supporters. */
export async function releaseBookedHouse(booking: FunderBooking) {
  const { error } = await supabase.rpc('funder_release_booked_houses', {
    p_house_ids: [booking.house_id],
    p_reason: 'given_up_by_funder',
  });
  if (error) throw new Error(String(error.message || 'Could not release this house'));
  void supabase.functions.invoke('notify-house-booking', { body: { note_id: booking.note_id } }).catch(() => {});
  window.dispatchEvent(new Event('supporter-contribution-changed'));
}
