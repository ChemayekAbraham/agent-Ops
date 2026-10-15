import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OperatingLocationGate } from './OperatingLocationGate';

const updateEq = vi.fn();
const update = vi.fn(() => ({ eq: updateEq }));
const refreshProfile = vi.fn();
let profile: Record<string, unknown> | null;

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ update }), rpc: vi.fn() },
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile, loading: false, refreshProfile }),
}));
vi.mock('@/hooks/useUgLocations', () => ({
  useUgVillageSearch: () => ({ data: [], isFetching: false }),
}));
vi.mock('@/components/location/UgDistrictSelect', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockGeolocation = (impl: (ok: PositionCallback, fail: PositionErrorCallback) => void) => {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: impl },
  });
};

describe('OperatingLocationGate', () => {
  beforeEach(() => {
    localStorage.clear();
    profile = { id: 'u1', district: null, village: null, residence_lat: null };
    updateEq.mockResolvedValue({ error: null });
    update.mockClear();
    refreshProfile.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('shows a dismissible dialog with a close button and a GPS option', () => {
    render(<OperatingLocationGate />);
    expect(screen.getByText('Where do you operate?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use my gps location/i })).toBeTruthy();
  });

  it('closes on the close button and stays away for 24 hours, then returns', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T08:00:00Z'));
    const first = render(<OperatingLocationGate />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText('Where do you operate?')).toBeNull();
    first.unmount();

    // Next load, 23h later: still snoozed.
    vi.setSystemTime(new Date('2026-10-16T07:00:00Z'));
    const second = render(<OperatingLocationGate />);
    expect(screen.queryByText('Where do you operate?')).toBeNull();
    second.unmount();

    // 25h later: comes back.
    vi.setSystemTime(new Date('2026-10-16T09:00:00Z'));
    render(<OperatingLocationGate />);
    expect(screen.getByText('Where do you operate?')).toBeTruthy();
  });

  it('saves a successful GPS fix to the profile and closes', async () => {
    mockGeolocation((ok) =>
      ok({ coords: { latitude: 0.347596, longitude: 32.58252, accuracy: 10 } } as GeolocationPosition),
    );
    render(<OperatingLocationGate />);
    fireEvent.click(screen.getByRole('button', { name: /use my gps location/i }));
    await waitFor(() => expect(refreshProfile).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ residence_lat: 0.347596, residence_lng: 32.58252 }),
    );
    expect(updateEq).toHaveBeenCalledWith('id', 'u1');
    expect(screen.queryByText('Where do you operate?')).toBeNull();
  });

  it('is never shown again once the profile has a GPS fix or a saved location', () => {
    profile = { id: 'u1', district: null, village: null, residence_lat: 0.35 };
    const gps = render(<OperatingLocationGate />);
    expect(screen.queryByText('Where do you operate?')).toBeNull();
    gps.unmount();
    profile = { id: 'u1', district: 'Kampala', village: 'Ntinda', residence_lat: null };
    render(<OperatingLocationGate />);
    expect(screen.queryByText('Where do you operate?')).toBeNull();
  });

  it('keeps the dialog open with guidance when GPS is denied, and saves nothing', async () => {
    mockGeolocation((_ok, fail) =>
      fail({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3, POSITION_UNAVAILABLE: 2, message: 'denied' } as GeolocationPositionError),
    );
    render(<OperatingLocationGate />);
    fireEvent.click(screen.getByRole('button', { name: /use my gps location/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/blocked/i));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('Where do you operate?')).toBeTruthy();
  });
});
