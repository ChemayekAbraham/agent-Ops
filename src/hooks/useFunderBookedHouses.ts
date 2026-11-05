import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';

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
  /** True when the house was taken over (tenant placed, delisted or claimed by another Supporter) and can no longer be funded. */
  taken: boolean;
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
  const held = bookings.filter((b) => b.status === 'reserved' && !b.taken);
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

/**
 * Full record for one booked house, shaped the way the Supporter's house
 * details sheet expects it (the same sheet the funder dashboard opens).
 * Landlord name/phone and the Returns figures are left for the sheet to fill,
 * so this stays one read of the listing itself.
 */
export async function loadBookedHouseDetails(houseId: string): Promise<HouseOpportunity> {
  const { data, error } = await supabase
    .from('house_listings')
    .select(
      `id, title, house_category, number_of_rooms, monthly_rent, region, district, sub_county, village,
       latitude, longitude, image_urls, landlord_id, verified, created_at`,
    )
    .eq('id', houseId)
    .maybeSingle();
  if (error) throw new Error(String(error.message || 'Could not load these house details.'));
  const row = data as Record<string, unknown> | null;
  if (!row) throw new Error('This house is no longer on the list, so its details cannot be opened.');

  const imageUrls = Array.isArray(row.image_urls)
    ? (row.image_urls as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : [];

  return {
    house_id: String(row.id ?? houseId),
    title: (row.title as string | null) ?? null,
    house_category: (row.house_category as string | null) ?? null,
    monthly_rent: Number(row.monthly_rent || 0),
    district: (row.district as string | null) ?? null,
    sub_county: (row.sub_county as string | null) ?? null,
    village: (row.village as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    number_of_rooms: (row.number_of_rooms as number | null) ?? null,
    verified: row.verified === true,
    listing_agent_id: null,
    listing_agent_name: null,
    image_url: imageUrls[0] ?? null,
    image_urls: imageUrls,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    landlord_id: (row.landlord_id as string | null) ?? null,
    landlord_name: null,
    landlord_phone: null,
    distance_km: null,
    created_at: (row.created_at as string | null) ?? null,
    partner_monthly_return: 0,
    partner_annual_return: 0,
  };
}
