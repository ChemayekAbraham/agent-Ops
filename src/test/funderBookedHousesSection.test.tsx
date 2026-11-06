import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { heldBookings, takenBooking, loadDetails } = vi.hoisted(() => ({
  loadDetails: vi.fn(async (houseId: string) => ({
    house_id: houseId,
    title: `Loaded ${houseId}`,
    house_category: 'single_room',
    monthly_rent: 30000,
    district: 'Kampala',
    sub_county: null,
    village: null,
    region: 'Central',
    number_of_rooms: 1,
    verified: true,
    listing_agent_id: null,
    listing_agent_name: null,
    image_url: null,
    image_urls: [],
    latitude: null,
    longitude: null,
    landlord_id: null,
    landlord_name: null,
    landlord_phone: null,
    distance_km: null,
    created_at: null,
    partner_monthly_return: 0,
    partner_annual_return: 0,
  })),
  takenBooking: {
    intent_id: 'intent-3',
    note_id: 'note-3',
    house_id: 'house-3',
    title: 'Double room at Mukono',
    district: 'Mukono',
    image_urls: [],
    verified: true,
    monthly_rent: 40000,
    status: 'reserved',
    promised_funding_date: null,
    reserved_until: '2026-11-10T00:00:00Z',
    released_at: null,
    release_reason: null,
    funded_at: null,
    days_left: 5,
    taken: true,
    created_at: '2026-11-05T00:00:00Z',
  },
  heldBookings: [
    {
      intent_id: 'intent-1',
      note_id: 'note-1',
      house_id: 'house-1',
      title: 'Bedsitter at Kira',
      district: 'Kampala',
      image_urls: [],
      verified: true,
      monthly_rent: 30000,
      status: 'reserved',
      promised_funding_date: null,
      reserved_until: '2026-11-10T00:00:00Z',
      released_at: null,
      release_reason: null,
      funded_at: null,
      days_left: 5,
      created_at: '2026-11-05T00:00:00Z',
    },
    {
      intent_id: 'intent-2',
      note_id: 'note-2',
      house_id: 'house-2',
      title: 'Single room at Nansana',
      district: 'Wakiso',
      image_urls: [],
      verified: false,
      monthly_rent: 30000,
      status: 'reserved',
      promised_funding_date: null,
      reserved_until: '2026-11-10T00:00:00Z',
      released_at: null,
      release_reason: null,
      funded_at: null,
      days_left: 5,
      created_at: '2026-11-05T00:00:00Z',
    },
  ],
}));

vi.mock('@/hooks/useFunderBookedHouses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useFunderBookedHouses')>();
  return {
    ...actual,
    useFunderBookedHouses: () => ({
      query: { isPending: false, isError: false, refetch: vi.fn() },
      bookings: [...heldBookings, takenBooking],
      held: heldBookings,
      heldCount: heldBookings.length,
    }),
    loadBookedHouseDetails: (houseId: string) => loadDetails(houseId),
  };
});

import { FunderBookedHousesSection } from '@/components/funder-new/FunderBookedHousesSection';

function mount(onOpenHouse = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <FunderBookedHousesSection onOpenHouse={onOpenHouse} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Booked for you section', () => {
  it('puts the fund-all action below the listed houses', () => {
    mount();
    const section = screen.getByRole('region', { name: 'Booked for you' });
    const order = Array.from(section.querySelectorAll('a, button')).map((el) => el.textContent ?? '');
    const fundIndex = order.findIndex((text) => text.includes('Fund all'));
    const firstRowIndex = order.findIndex((text) => text.includes('Bedsitter at Kira'));
    const lastRowIndex = order.map((text) => text.includes('Single room at Nansana')).lastIndexOf(true);
    expect(fundIndex).toBeGreaterThan(-1);
    expect(firstRowIndex).toBeGreaterThan(-1);
    expect(lastRowIndex).toBeGreaterThan(-1);
    expect(fundIndex).toBeGreaterThan(firstRowIndex);
    expect(fundIndex).toBeGreaterThan(lastRowIndex);
  });

  it('opens a listed house in the Supporter house details, never the public house page', async () => {
    const onOpenHouse = vi.fn();
    mount(onOpenHouse);
    const row = screen.getByRole('button', { name: 'Open details for Bedsitter at Kira' });
    fireEvent.click(row);
    await waitFor(() => expect(onOpenHouse).toHaveBeenCalled());
    expect(onOpenHouse.mock.calls[0][0].house_id).toBe('house-1');
    expect(screen.queryByRole('link', { name: 'Open details for Bedsitter at Kira' })).toBeNull();
    expect(document.querySelector('a[href="/house/house-1"]')).toBeNull();
  });

  it('shows Give up in danger red', () => {
    mount();
    const giveUp = screen.getByRole('button', { name: 'Give up Bedsitter at Kira' });
    expect(giveUp.className).toContain('text-destructive');
    expect(giveUp.className).toContain('border-destructive');
  });

  it('marks a taken house as Taken with no way to fund or give it up', () => {
    mount();
    const row = screen.getByRole('button', { name: 'Open details for Double room at Mukono' });
    expect(row.textContent).toContain('Taken');
    expect(screen.queryByRole('button', { name: 'Give up Double room at Mukono' })).toBeNull();
    // The fund-all total counts only the two still-held houses (2 × 30,000), not the taken one.
    expect(screen.getByRole('button', { name: /Fund all 2 held/ }).textContent).toContain('60,000');
  });
});
