import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GPS_DENIED_LINE, GPS_IMPROVE_MS, GPS_MAX_AGE_MS, GPS_NO_SIGNAL_LINE, NETWORK_FIX_OPTIONS, gpsCapturedLine, gpsFailLine, gpsFindingLine, gpsPermissionDenied,
  isInAppBrowser, systemBrowserUrl, watchHouseGps,
} from '@/lib/gpsCapture';

/** A geolocation whose readings and errors the test sends. */
function fakeGeo() {
  let onPos: PositionCallback = () => {};
  let onErr: PositionErrorCallback = () => {};
  let onNet: PositionCallback = () => {};
  const raw = {
    watchPosition: vi.fn((s: PositionCallback, e: PositionErrorCallback) => { onPos = s; onErr = e; return 7; }),
    clearWatch: vi.fn(),
    getCurrentPosition: vi.fn((s: PositionCallback) => { onNet = s; }),
  };
  return {
    geo: raw as unknown as Geolocation,
    raw,
    /** A reading from the GPS watch (high accuracy). */
    reading: (accuracy: number, lat = 0.33) => onPos({ coords: { latitude: lat, longitude: 32.58, accuracy } } as GeolocationPosition),
    /** A reading from the network / last-known request. */
    network: (accuracy: number, lat = 0.31) => onNet({ coords: { latitude: lat, longitude: 32.58, accuracy } } as GeolocationPosition),
    error: (code: number) => onErr({ code, message: 'x' } as GeolocationPositionError),
  };
}

afterEach(() => vi.useRealTimers());

describe('house GPS: network and GPS at once, the first reading kept, improved for 60 s', () => {
  it('the network reading is accepted first, then the high-accuracy one replaces it', async () => {
    vi.useFakeTimers();
    const g = fakeGeo();
    const onFix = vi.fn();
    const onEnd = vi.fn();
    watchHouseGps({ geolocation: g.geo, onFix, onEnd });
    // Both requests start at once.
    expect(g.raw.getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), NETWORK_FIX_OPTIONS);
    expect(NETWORK_FIX_OPTIONS).toEqual({ enableHighAccuracy: false, maximumAge: 600000, timeout: 20000 });
    expect(g.raw.watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { enableHighAccuracy: true, maximumAge: 0 });
    g.network(350);
    expect(onFix).toHaveBeenLastCalledWith({ lat: 0.31, lng: 32.58, accuracy: 350, source: 'gps' }, true);
    await vi.advanceTimersByTimeAsync(40_000); // an old chip: the GPS fix comes late
    g.reading(25, 0.34);
    expect(onFix).toHaveBeenLastCalledWith({ lat: 0.34, lng: 32.58, accuracy: 25, source: 'gps' }, false);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onEnd).toHaveBeenCalledWith(null);
  });

  it('the first reading is taken at once, any accuracy; better ones follow; the watch ends after 60 s', async () => {
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
    expect(gpsCapturedLine({ lat: 0.347621, lng: 32.582514, accuracy: 39.6 })).toBe('Location captured ✓ 0.34762, 32.58251 (±40 m)');
    expect(gpsFailLine('gps_permission_denied')).toBe(GPS_DENIED_LINE);
    expect(gpsFailLine('gps_timeout')).toBe(GPS_NO_SIGNAL_LINE);
    expect(gpsFailLine('gps_unavailable')).toBe(GPS_NO_SIGNAL_LINE);
  });

  it('in-app browsers, and the link that opens the page in Chrome', () => {
    expect(gpsFindingLine(12)).toBe('Finding your location… 12 s');
    expect(gpsCapturedLine({ lat: 0.347621, lng: 32.582514, accuracy: 350 }, true)).toBe('Location captured ✓ 0.34762, 32.58251 (±350 m) — it will sharpen if you stay here');
    expect(GPS_NO_SIGNAL_LINE).toBe('No location yet — step outside under open sky, then tap Capture again.');
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 13) Chrome/119 Mobile Safari/537.36 WhatsApp/2.23')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 12) Instagram 300.0 Android')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 12) Telegram-Android/10.2')).toBe(true);
    expect(isInAppBrowser('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/119.0 Mobile Safari/537.36')).toBe(false);
    expect(systemBrowserUrl('https://welile.com/agent?x=1', 'Android WhatsApp'))
      .toBe('intent://welile.com/agent?x=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fwelile.com%2Fagent%3Fx%3D1;end');
    expect(systemBrowserUrl('https://welile.com/agent', 'iPhone FBAN')).toBe('https://welile.com/agent');
  });

  it('a site already blocked is known before the tap', async () => {
    await expect(gpsPermissionDenied({ permissions: { query: async () => ({ state: 'denied' }) } } as unknown as Navigator)).resolves.toBe(true);
    await expect(gpsPermissionDenied({ permissions: { query: async () => ({ state: 'prompt' }) } } as unknown as Navigator)).resolves.toBe(false);
    await expect(gpsPermissionDenied({} as Navigator)).resolves.toBe(false);
  });

  it('no map component exists any more', async () => {
    const modules = import.meta.glob('/src/components/intake/*.tsx');
    expect(Object.keys(modules).some((k) => /PinDropMap/.test(k))).toBe(false);
  });
});
