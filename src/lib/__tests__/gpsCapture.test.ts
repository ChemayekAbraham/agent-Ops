import { afterEach, describe, expect, it, vi } from 'vitest';
import { GPS_IMPROVE_MS, GPS_MAX_AGE_MS, gpsFoundLine, watchHouseGps } from '@/lib/gpsCapture';

/** A geolocation whose readings and errors the test sends. */
function fakeGeo() {
  let onPos: PositionCallback = () => {};
  let onErr: PositionErrorCallback = () => {};
  const raw = {
    watchPosition: vi.fn((s: PositionCallback, e: PositionErrorCallback) => { onPos = s; onErr = e; return 7; }),
    clearWatch: vi.fn(),
    getCurrentPosition: vi.fn(),
  };
  return {
    geo: raw as unknown as Geolocation,
    raw,
    reading: (accuracy: number) => onPos({ coords: { latitude: 0.33, longitude: 32.58, accuracy } } as GeolocationPosition),
    error: (code: number) => onErr({ code, message: 'x' } as GeolocationPositionError),
  };
}

afterEach(() => vi.useRealTimers());

describe('house GPS: the first reading at once, improved for 15 s', () => {
  it('the first reading is taken at once, any accuracy; better ones follow; the watch ends after 15 s', async () => {
    vi.useFakeTimers();
    const g = fakeGeo();
    const onFix = vi.fn();
    const onEnd = vi.fn();
    watchHouseGps({ geolocation: g.geo, onFix, onEnd });
    expect(g.raw.watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true, maximumAge: GPS_MAX_AGE_MS }));
    g.reading(420);
    expect(onFix).toHaveBeenLastCalledWith({ lat: 0.33, lng: 32.58, accuracy: 420, source: 'gps' }, true);
    g.reading(60);
    g.reading(90); // worse: ignored
    expect(onFix).toHaveBeenCalledTimes(2);
    expect(onFix).toHaveBeenLastCalledWith(expect.objectContaining({ accuracy: 60 }), false);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GPS_IMPROVE_MS);
    expect(onEnd).toHaveBeenCalledWith(null);
    expect(g.raw.clearWatch).toHaveBeenCalledWith(7);
  });

  it('no reading: permission denied at once; nothing in 15 s is a timeout; a position error is unavailable', async () => {
    vi.useFakeTimers();
    let g = fakeGeo();
    let onEnd = vi.fn();
    watchHouseGps({ geolocation: g.geo, onFix: vi.fn(), onEnd });
    g.error(1);
    expect(onEnd).toHaveBeenCalledWith('gps_permission_denied');

    g = fakeGeo();
    onEnd = vi.fn();
    watchHouseGps({ geolocation: g.geo, onFix: vi.fn(), onEnd });
    g.error(3);
    await vi.advanceTimersByTimeAsync(GPS_IMPROVE_MS);
    expect(onEnd).toHaveBeenCalledWith('gps_timeout');

    g = fakeGeo();
    onEnd = vi.fn();
    watchHouseGps({ geolocation: g.geo, onFix: vi.fn(), onEnd });
    g.error(2);
    await vi.advanceTimersByTimeAsync(GPS_IMPROVE_MS);
    expect(onEnd).toHaveBeenCalledWith('gps_unavailable');

    onEnd = vi.fn();
    watchHouseGps({ geolocation: null, onFix: vi.fn(), onEnd });
    await vi.advanceTimersByTimeAsync(0);
    expect(onEnd).toHaveBeenCalledWith('gps_unavailable');
  });

  it('the lines it says', () => {
    expect(gpsFoundLine({ lat: 0, lng: 0, accuracy: 59.6, source: 'gps' })).toBe('Location found (±60 m) ✓');
    expect(gpsFoundLine({ lat: 0, lng: 0, accuracy: null, source: 'pin' })).toBe('Pin dropped on the house ✓');
  });
});
