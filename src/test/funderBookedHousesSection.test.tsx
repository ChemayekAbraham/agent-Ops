import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { heldBookings } = vi.hoisted(() => ({
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
      bookings: heldBookings,
      held: heldBookings,
      heldCount: heldBookings.length,
    }),
  };
});

import { FunderBookedHousesSection } from '@/components/funder-new/FunderBookedHousesSection';

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <FunderBookedHousesSection />
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

  it('opens each listed house on its details page', () => {
    mount();
    expect(screen.getByRole('link', { name: 'Open details for Bedsitter at Kira' }).getAttribute('href')).toBe('/house/house-1');
    expect(screen.getByRole('link', { name: 'Open details for Single room at Nansana' }).getAttribute('href')).toBe('/house/house-2');
  });

  it('shows Give up in danger red', () => {
    mount();
    const giveUp = screen.getByRole('button', { name: 'Give up Bedsitter at Kira' });
    expect(giveUp.className).toContain('text-destructive');
    expect(giveUp.className).toContain('border-destructive');
  });
});
