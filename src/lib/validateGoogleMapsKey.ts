/// <reference types="google.maps" />

/**
 * Client-side validation for a Google Maps *browser* API key.
 *
 * The only reliable way to know a browser key is usable on the current domain
 * is to actually load the Maps JavaScript API with it and watch for Google's
 * `gm_authFailure` global, which fires on RefererNotAllowedMapError and
 * InvalidKeyMapError. We do this in a controlled, one-shot way and restore any
 * pre-existing handler afterwards.
 */
export type MapsKeyFailureReason =
  | 'format'
  | 'referrer'
  | 'network'
  | 'timeout'
  | 'already-loaded';

export interface MapsKeyValidation {
  ok: boolean;
  reason?: MapsKeyFailureReason;
  message?: string;
}

const FRIENDLY: Record<MapsKeyFailureReason, string> = {
  format: 'That doesn\'t look like a Google Maps API key. Keys usually start with "AIza".',
  referrer:
    'Google rejected this key for this website. Add this domain to the key\'s HTTP referrer allowlist in Google Cloud (e.g. https://welileapp.com/* and https://*.welileapp.com/*), and make sure the Maps JavaScript API is enabled.',
  network: 'Could not reach Google to verify the key. Check your internet connection and try again.',
  timeout: 'Verifying the key timed out. Check the key and your connection, then try again.',
  'already-loaded':
    'Google Maps is already loaded on this page, so a new key can only be fully verified after reloading the app.',
};

/** Quick shape check before doing any network work. */
function looksLikeKey(key: string): boolean {
  // Google API keys are ~39 chars and start with "AIza"; keep this lenient.
  return /^AIza[0-9A-Za-z_-]{20,}$/.test(key);
}

export async function validateGoogleMapsKey(rawKey: string, timeoutMs = 9000): Promise<MapsKeyValidation> {
  const key = rawKey.trim();
  if (!looksLikeKey(key)) return { ok: false, reason: 'format', message: FRIENDLY.format };

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { ok: false, reason: 'network', message: FRIENDLY.network };
  }

  // If Maps is already on the page we cannot meaningfully reload with a
  // different key — Google blocks loading the JS API twice.
  if ((window as unknown as { google?: { maps?: unknown } }).google?.maps) {
    return { ok: false, reason: 'already-loaded', message: FRIENDLY['already-loaded'] };
  }

  return new Promise<MapsKeyValidation>((resolve) => {
    const cbName = `__welileValidateMaps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const w = window as unknown as Record<string, unknown> & { gm_authFailure?: () => void };
    const prevAuthFailure = w.gm_authFailure;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      w.gm_authFailure = prevAuthFailure;
      try { delete w[cbName]; } catch { w[cbName] = undefined; }
      script.remove();
    };
    const finish = (result: MapsKeyValidation) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // Google calls this on auth/referrer failure.
    w.gm_authFailure = () => finish({ ok: false, reason: 'referrer', message: FRIENDLY.referrer });
    // Google calls this on successful init.
    w[cbName] = () => finish({ ok: true });

    const params = new URLSearchParams({ key, loading: 'async', callback: cbName });
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => finish({ ok: false, reason: 'network', message: FRIENDLY.network });
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout', message: FRIENDLY.timeout }), timeoutMs);
    document.head.appendChild(script);
  });
}
