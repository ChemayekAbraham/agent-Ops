/**
 * GPS of the house for the rent-request intake (agent chat and /tenants-onboarding).
 * It must just work: the only prompt the agent sees is the browser's own "Allow".
 *
 *   - watchPosition (high accuracy, readings up to 60 s old allowed); the FIRST reading is
 *     accepted at once, whatever its accuracy, and the agent can continue;
 *   - it keeps improving the reading for up to 15 s in the background;
 *   - no reading at all (permission denied, unavailable, or nothing in 15 s): the agent drops a
 *     pin on the house on a map instead (source 'pin', accuracy unknown). Never a dead end,
 *     never a trip to the phone's settings.
 * Reason codes for request_form_log: gps_permission_denied, gps_timeout, gps_unavailable,
 * gps_pin_used.
 */

export const GPS_IMPROVE_MS = 15_000;
export const GPS_MAX_AGE_MS = 60_000;
/** Kampala: where the pin map opens when nothing better is known. */
export const DEFAULT_MAP_CENTRE = { lat: 0.3476, lng: 32.5825 };

export type GpsFailCode = 'gps_permission_denied' | 'gps_timeout' | 'gps_unavailable';
export type GpsSource = 'gps' | 'pin';
export interface GpsFix { lat: number; lng: number; accuracy: number | null; source: GpsSource }

const getGeo = (geo?: Geolocation | null): Geolocation | null =>
  geo !== undefined ? geo : (typeof navigator !== 'undefined' ? navigator.geolocation ?? null : null);

/**
 * Starts watching. onFix runs for the first reading and for each better one; onEnd runs once:
 * with null when there was at least one reading, or with the reason there was none. Returns stop().
 */
export function watchHouseGps(opts: {
  onFix: (fix: GpsFix, first: boolean) => void;
  onEnd: (failure: GpsFailCode | null) => void;
  windowMs?: number;
  geolocation?: Geolocation | null;
}): () => void {
  const geo = getGeo(opts.geolocation);
  let ended = false;
  let best: GpsFix | null = null;
  let sawUnavailable = false;
  let watchId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const end = (failure: GpsFailCode | null) => {
    if (ended) return;
    ended = true;
    if (watchId !== null) { try { geo?.clearWatch(watchId); } catch { /* ignore */ } }
    if (timer) clearTimeout(timer);
    opts.onEnd(failure);
  };
  if (!geo || typeof geo.watchPosition !== 'function') {
    // Reported after the caller has its stop() in hand.
    queueMicrotask(() => end('gps_unavailable'));
    return () => end(null);
  }
  timer = setTimeout(() => end(best ? null : sawUnavailable ? 'gps_unavailable' : 'gps_timeout'), opts.windowMs ?? GPS_IMPROVE_MS);
  try {
    watchId = geo.watchPosition(
      (pos) => {
        if (ended) return;
        const acc = Number(pos.coords.accuracy);
        const fix: GpsFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Number.isFinite(acc) ? acc : null, source: 'gps' };
        const first = !best;
        if (first || (fix.accuracy !== null && (best!.accuracy === null || fix.accuracy < best!.accuracy))) {
          best = fix;
          opts.onFix(fix, first);
        }
      },
      (err) => {
        if (ended) return;
        // Denied: no reading will come, so straight to the pin. Unavailable / timeout: the phone
        // often recovers, so keep watching until the window ends.
        if (err.code === 1 && !best) end('gps_permission_denied');
        else if (err.code === 2) sawUnavailable = true;
      },
      { enableHighAccuracy: true, maximumAge: GPS_MAX_AGE_MS, timeout: opts.windowMs ?? GPS_IMPROVE_MS },
    );
  } catch {
    queueMicrotask(() => end('gps_unavailable'));
  }
  return () => end(null);
}

/**
 * Where the pin map opens: a rough network fix if the phone gives one quickly (no high
 * accuracy, any age), else the given fallback (the last known reading), else Kampala.
 */
export function networkCentre(fallback?: { lat: number; lng: number } | null, geolocation?: Geolocation | null): Promise<{ lat: number; lng: number }> {
  const geo = getGeo(geolocation);
  const base = fallback ?? DEFAULT_MAP_CENTRE;
  if (!geo || typeof geo.getCurrentPosition !== 'function') return Promise.resolve(base);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { lat: number; lng: number }) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(base), 4000);
    try {
      geo.getCurrentPosition(
        (p) => finish({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => finish(base),
        { enableHighAccuracy: false, maximumAge: Infinity, timeout: 4000 },
      );
    } catch {
      finish(base);
    }
  });
}

/** "Location found (±60 m) ✓", or for a pin "Pin dropped on the house ✓". */
export function gpsFoundLine(fix: GpsFix): string {
  if (fix.source === 'pin') return 'Pin dropped on the house ✓';
  return fix.accuracy !== null ? `Location found (±${Math.round(fix.accuracy)} m) ✓` : 'Location found ✓';
}
