/**
 * GPS of the house for the rent-request intake (agent chat step 4 and /tenants-onboarding).
 * "Capture location" just captures and stores the coordinates. No map anywhere.
 *
 *   - two requests at once: the network / last-known location (getCurrentPosition, low accuracy,
 *     up to 10 min old, usually within seconds) and the GPS (watchPosition, high accuracy). The
 *     FIRST reading from either is accepted at once, any accuracy ("Location captured ✓ 0.34762,
 *     32.58251 (±350 m) — it will sharpen if you stay here"), then improved silently for up to
 *     60 s: old phones' GPS chips need 30–60 s;
 *   - permission denied (the browser answers at once when the site is blocked): one line on how
 *     to allow it; shown before the tap too when navigator.permissions already says 'denied';
 *   - no reading at all in 60 s (timeout / unavailable): one line to step outside and try again;
 *   - inside WhatsApp / Facebook / Instagram / Telegram's own browser: "Open this page in Chrome".
 * Reason codes for request_form_log: gps_permission_denied, gps_timeout, gps_unavailable,
 * gps_in_app_browser.
 */

/** How long a Capture keeps looking (and improving): old GPS chips need 30–60 s. */
export const GPS_IMPROVE_MS = 60_000;
/** The GPS watch wants a fresh fix. */
export const GPS_MAX_AGE_MS = 0;
/** The network / last-known location: any reading up to 10 minutes old, within 20 s. */
export const NETWORK_FIX_OPTIONS: PositionOptions = { enableHighAccuracy: false, maximumAge: 600_000, timeout: 20_000 };

export type GpsFailCode = 'gps_permission_denied' | 'gps_timeout' | 'gps_unavailable';
export type GpsSource = 'gps';
export interface GpsFix { lat: number; lng: number; accuracy: number | null; source: GpsSource }

/** The lines the agent sees. */
export const GPS_DENIED_LINE = 'Location is blocked for Welile in this browser. Tap the 🔒 in the address bar → Location → Allow, then tap Capture again.';
export const GPS_NO_SIGNAL_LINE = 'No location yet — step outside under open sky, then tap Capture again.';
export const GPS_SHARPEN_NOTE = ' — it will sharpen if you stay here';
export const GPS_IN_APP_LINE = 'Open this page in Chrome to capture location';

const getGeo = (geo?: Geolocation | null): Geolocation | null =>
  geo !== undefined ? geo : (typeof navigator !== 'undefined' ? navigator.geolocation ?? null : null);

/**
 * Starts both requests. onFix runs for the first reading (network or GPS) and for each better
 * one; onEnd runs once, after the window: with null when there was at least one reading, or with
 * the reason there was none. Returns stop().
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
  const onPosition = (pos: GeolocationPosition) => {
    if (ended) return;
    const acc = Number(pos.coords.accuracy);
    const fix: GpsFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Number.isFinite(acc) ? acc : null, source: 'gps' };
    const first = !best;
    if (first || (fix.accuracy !== null && (best!.accuracy === null || fix.accuracy < best!.accuracy))) {
      best = fix;
      opts.onFix(fix, first);
    }
  };
  const onError = (err: GeolocationPositionError) => {
    if (ended) return;
    // Denied: nothing will come. Unavailable / timeout: the phone often recovers, so keep
    // looking until the window ends.
    if (err.code === 1 && !best) end('gps_permission_denied');
    else if (err.code === 2) sawUnavailable = true;
  };
  try {
    // (a) The network / last-known location: rough, but usually there within seconds.
    if (typeof geo.getCurrentPosition === 'function') geo.getCurrentPosition(onPosition, onError, NETWORK_FIX_OPTIONS);
    // (b) The GPS itself, fresh and high accuracy; better readings replace the first one.
    watchId = geo.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: GPS_MAX_AGE_MS });
  } catch {
    queueMicrotask(() => end('gps_unavailable'));
  }
  return () => end(null);
}

/** "Location captured ✓ 0.34762, 32.58251 (±40 m)", plus " — it will sharpen…" while improving. */
export function gpsCapturedLine(fix: { lat: number; lng: number; accuracy: number | null }, improving = false): string {
  const acc = fix.accuracy !== null && Number.isFinite(fix.accuracy) ? ` (±${Math.round(fix.accuracy)} m)` : '';
  return `Location captured ✓ ${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}${acc}${improving ? GPS_SHARPEN_NOTE : ''}`;
}

/** "Finding your location… 12 s" while a Capture has no reading yet. */
export const gpsFindingLine = (seconds: number): string => `Finding your location… ${seconds} s`;

/** The line for a capture that got no reading. */
export const gpsFailLine = (code: GpsFailCode): string => (code === 'gps_permission_denied' ? GPS_DENIED_LINE : GPS_NO_SIGNAL_LINE);

/** Whether the browser already says the site may not read the location (no prompt will come). */
export async function gpsPermissionDenied(nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined): Promise<boolean> {
  try {
    const status = await nav?.permissions?.query({ name: 'geolocation' as PermissionName });
    return status?.state === 'denied';
  } catch {
    return false;
  }
}

/** WhatsApp, Facebook (incl. Messenger), Instagram or Telegram's own in-app browser. */
export function isInAppBrowser(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /WhatsApp|FBAN|FBAV|FB_IAB|FBIOS|Instagram|Telegram/i.test(ua);
}

/**
 * The same page in the phone's own browser: an intent:// link that opens Chrome on Android;
 * elsewhere the plain address (the in-app browser's "Open in browser" handles it).
 */
export function systemBrowserUrl(href: string, ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (!/Android/i.test(ua)) return href;
  try {
    const u = new URL(href);
    return `intent://${u.host}${u.pathname}${u.search}${u.hash}#Intent;scheme=${u.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`;
  } catch {
    return href;
  }
}
