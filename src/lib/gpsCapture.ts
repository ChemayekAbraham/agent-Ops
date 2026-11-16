/**
 * GPS of the house for the rent-request intake (agent chat step 4 and /tenants-onboarding).
 * "Capture location" just captures and stores the coordinates. No map anywhere.
 *
 *   - watchPosition (high accuracy, readings up to 60 s old allowed); the FIRST reading is
 *     accepted at once ("Location captured ✓ 0.34762, 32.58251 (±40 m)") and improved silently
 *     for up to 15 s;
 *   - permission denied (the browser answers at once when the site is blocked): one line on how
 *     to allow it; shown before the tap too when navigator.permissions already says 'denied';
 *   - no reading in 15 s (timeout / unavailable): one line to step outside and try again;
 *   - inside WhatsApp / Facebook / Instagram / Telegram's own browser: "Open this page in Chrome".
 * Reason codes for request_form_log: gps_permission_denied, gps_timeout, gps_unavailable,
 * gps_in_app_browser.
 */

export const GPS_IMPROVE_MS = 15_000;
export const GPS_MAX_AGE_MS = 60_000;

export type GpsFailCode = 'gps_permission_denied' | 'gps_timeout' | 'gps_unavailable';
export type GpsSource = 'gps';
export interface GpsFix { lat: number; lng: number; accuracy: number | null; source: GpsSource }

/** The lines the agent sees. */
export const GPS_DENIED_LINE = 'Location is blocked for Welile in this browser. Tap the 🔒 in the address bar → Location → Allow, then tap Capture again.';
export const GPS_NO_SIGNAL_LINE = 'No GPS signal here — step outside or near a window and tap Capture again.';
export const GPS_IN_APP_LINE = 'Open this page in Chrome to capture location';

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
        // Denied: nothing will come. Unavailable / timeout: the phone often recovers, so keep
        // watching until the window ends.
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

/** "Location captured ✓ 0.34762, 32.58251 (±40 m)". */
export function gpsCapturedLine(fix: { lat: number; lng: number; accuracy: number | null }): string {
  const acc = fix.accuracy !== null && Number.isFinite(fix.accuracy) ? ` (±${Math.round(fix.accuracy)} m)` : '';
  return `Location captured ✓ ${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}${acc}`;
}

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
