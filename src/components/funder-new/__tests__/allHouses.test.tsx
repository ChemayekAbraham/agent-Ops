import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({ requireUserSession: async () => {}, useAuthenticatedAudience: () => true }));
vi.mock('@/hooks/useFunderEmptyHousesSwitch', () => ({ useFunderEmptyHousesAllowed: () => true }));

import { useFunderNewEmptyHouses } from '../useFunderNewOpportunities';
import { withinRadius } from '../feedOrder';
import type { FunderNewFilters, FunderNewOrigin } from '../types';

const FILTERS: FunderNewFilters = { search: '', location: '', amount: 'all', sort: 'nearest', rentMin: null, rentMax: null, radiusKm: 'all', withinFloat: false };
const ORIGIN: FunderNewOrigin = { lat: 0.3476, lng: 32.5825, source: 'device', radiusKm: null, label: 'your location' };

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: { houses: [], total: 783 }, error: null });
});

describe('all houses by default', () => {
  it('with a location and no distance chosen: nearest-first, no radius, houses without a pin kept', async () => {
    renderHook(() => useFunderNewEmptyHouses(FILTERS, ORIGIN, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    const [fn, args] = rpcMock.mock.calls[0];
    expect(fn).toBe('agent_list_empty_house_opportunities');
    expect(args).toMatchObject({ p_sort: 'nearest', p_radius_km: null, p_gps_only: false, p_near_lat: ORIGIN.lat, p_near_lng: ORIGIN.lng });
  });

  it('any sort still sends the position (for distances) but never a radius by default', async () => {
    renderHook(() => useFunderNewEmptyHouses({ ...FILTERS, sort: 'recommended' }, ORIGIN, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_sort: 'recommended', p_radius_km: null, p_gps_only: false, p_near_lat: ORIGIN.lat });
  });

  it('a distance the funder chooses limits the list (and needs a pin)', async () => {
    renderHook(() => useFunderNewEmptyHouses({ ...FILTERS, sort: 'recommended', radiusKm: 10 }, { ...ORIGIN, radiusKm: 10 }, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_radius_km: 10, p_gps_only: true });
  });

  it('no location: no position, no radius', async () => {
    renderHook(() => useFunderNewEmptyHouses(FILTERS, null, true), { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_sort: 'recommended', p_radius_km: null, p_gps_only: false, p_near_lat: null });
  });

  it('withinRadius: only a chosen radius hides anything', () => {
    expect(withinRadius(197, null)).toBe(true);
    expect(withinRadius(null, null)).toBe(true);
    expect(withinRadius(3.2, 5)).toBe(true);
    expect(withinRadius(12, 5)).toBe(false);
    expect(withinRadius(null, 5)).toBe(false);
  });
});
