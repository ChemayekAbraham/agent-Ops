import { useCallback, useEffect, useRef, useState } from 'react';
import { gpsPermissionDenied, isInAppBrowser, watchHouseGps, type GpsFailCode, type GpsFix } from '@/lib/gpsCapture';

/**
 * The house GPS for the intake forms (gpsCapture.ts). One tap: the browser's Allow (first time
 * only), then the first reading is taken at once and improved silently for up to 15 s.
 *
 *   asking    waiting for the first reading
 *   improving a reading is in; better ones may still come
 *   done      the watch is over with a reading
 *   failed    no reading: `failure` says why (blocked, or no signal)
 */
export type GpsPhase = 'idle' | 'asking' | 'improving' | 'done' | 'failed';

export function useGpsCapture(handlers: {
  /** Each reading: the first one (first = true), then each better one. */
  onFix?: (fix: GpsFix, first: boolean) => void;
  /** Why there is no reading. */
  onFail?: (code: GpsFailCode) => void;
  /** The page is open inside WhatsApp / Facebook / Instagram / Telegram (once). */
  onInAppBrowser?: () => void;
} = {}) {
  const [phase, setPhase] = useState<GpsPhase>('idle');
  const [location, setLocation] = useState<GpsFix | null>(null);
  const [failure, setFailure] = useState<GpsFailCode | null>(null);
  const [inAppBrowser] = useState(() => isInAppBrowser());
  const stop = useRef<(() => void) | null>(null);
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => () => stop.current?.(), []);

  // Before any tap: a site the browser has already blocked shows the line at once.
  useEffect(() => {
    let live = true;
    void gpsPermissionDenied().then((denied) => {
      if (live && denied) { setFailure((f) => f ?? 'gps_permission_denied'); setPhase((p) => (p === 'idle' ? 'failed' : p)); }
    });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (inAppBrowser) h.current.onInAppBrowser?.(); }, [inAppBrowser]);

  const capture = useCallback(() => {
    stop.current?.();
    setFailure(null);
    setPhase('asking');
    let gotOne = false;
    stop.current = watchHouseGps({
      onFix: (fix, first) => {
        gotOne = true;
        setLocation(fix);
        setPhase('improving');
        h.current.onFix?.(fix, first);
      },
      onEnd: (code) => {
        stop.current = null;
        if (code && !gotOne) {
          setFailure(code);
          setPhase('failed');
          h.current.onFail?.(code);
        } else {
          setPhase('done');
        }
      },
    });
  }, []);

  return { phase, location, failure, inAppBrowser, capture };
}
export type GpsCaptureState = ReturnType<typeof useGpsCapture>;
