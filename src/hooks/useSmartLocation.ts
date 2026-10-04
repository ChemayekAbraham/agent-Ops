import { useCallback, useState } from 'react';

/**
 * Resilient geolocation hook.
 *
 * Strategy:
 *  1. Try high-accuracy fix (5s timeout)
 *  2. On timeout/error, retry with low-accuracy (10s timeout)
 *  3. Always resolve — never block the UI indefinitely
 *
 * Use this in place of `navigator.geolocation.getCurrentPosition` everywhere.
 * Components MUST NOT call `navigator.geolocation` directly anymore.
 */

export type SmartLocationResult =
  | {
      ok: true;
      latitude: number;
      longitude: number;
      accuracy: number;
      source: 'high' | 'low';
    }
  | {
      ok: false;
      reason: 'unsupported' | 'denied' | 'unavailable' | 'timeout' | 'unknown';
      message: string;
    };

const HIGH_ACCURACY_OPTS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 5000,
  maximumAge: 0,
};

const LOW_ACCURACY_OPTS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10000,
  maximumAge: 60_000,
};

function attempt(opts: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    // Defensive: enforce hard ceiling so a misbehaving device cannot freeze us.
    const hardCeiling = (opts.timeout ?? 10_000) + 2_000;
    let settled = false;
    let watchId: number | null = null;

    const cleanup = () => {
      if (watchId != null) {
        try {
          navigator.geolocation.clearWatch(watchId);
        } catch {
          /* ignore */
        }
        watchId = null;
      }
    };

    // Hard ceiling so a misbehaving device cannot freeze us forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error('timeout') as any;
      err.code = 3;
      reject(err);
    }, hardCeiling);

    // IMPORTANT (mobile reliability): On many Android Chrome builds and some
    // in-app browsers, `getCurrentPosition` with high accuracy never fires
    // EITHER callback — the request silently hangs, so the button "does
    // nothing". `watchPosition` is the documented workaround: it reliably
    // emits the first available fix. We take the first reading, then clear it.
    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(pos);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(err);
        },
        opts,
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    }
  });
}

function classify(err: any): SmartLocationResult {
  if (!err) return { ok: false, reason: 'unknown', message: 'Unknown geolocation error' };
  if (err.message === 'unsupported') {
    return { ok: false, reason: 'unsupported', message: 'Geolocation is not supported on this device' };
  }
  switch (err.code) {
    case 1:
      return { ok: false, reason: 'denied', message: 'Location permission was denied' };
    case 2:
      return { ok: false, reason: 'unavailable', message: 'Location is currently unavailable' };
    case 3:
      return { ok: false, reason: 'timeout', message: 'Location request timed out' };
    default:
      return { ok: false, reason: 'unknown', message: err.message ?? 'Unknown geolocation error' };
  }
}

/**
 * Imperative API: `const { capture } = useSmartLocation(); const result = await capture();`
 * Always resolves (never throws). UI should branch on `result.ok`.
 */
export function useSmartLocation() {
  const [loading, setLoading] = useState(false);
  const [last, setLast] = useState<SmartLocationResult | null>(null);

  const capture = useCallback(async (): Promise<SmartLocationResult> => {
    setLoading(true);
    try {
      // 1) High-accuracy attempt
      try {
        const pos = await attempt(HIGH_ACCURACY_OPTS);
        const result: SmartLocationResult = {
          ok: true,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          source: 'high',
        };
        setLast(result);
        return result;
      } catch (highErr: any) {
        // Permission-denied is terminal — don't retry, the second attempt will also fail.
        if (highErr?.code === 1) {
          const result = classify(highErr);
          setLast(result);
          return result;
        }
      }

      // 2) Low-accuracy fallback
      try {
        const pos = await attempt(LOW_ACCURACY_OPTS);
        const result: SmartLocationResult = {
          ok: true,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          source: 'low',
        };
        setLast(result);
        return result;
      } catch (lowErr: any) {
        const result = classify(lowErr);
        setLast(result);
        return result;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  return { capture, loading, last };
}

/**
 * Standalone helper for places that cannot use a React hook (e.g. utility modules,
 * event handlers outside a component). Same resilience guarantees.
 */
export async function captureSmartLocation(): Promise<SmartLocationResult> {
  try {
    const pos = await attempt(HIGH_ACCURACY_OPTS);
    return {
      ok: true,
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      source: 'high',
    };
  } catch (highErr: any) {
    if (highErr?.code === 1) return classify(highErr);
  }
  try {
    const pos = await attempt(LOW_ACCURACY_OPTS);
    return {
      ok: true,
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      source: 'low',
    };
  } catch (lowErr: any) {
    return classify(lowErr);
  }
}