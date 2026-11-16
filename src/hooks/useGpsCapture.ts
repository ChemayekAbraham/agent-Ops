import { useCallback, useEffect, useRef, useState } from 'react';
import { watchHouseGps, type GpsFailCode, type GpsFix } from '@/lib/gpsCapture';

/**
 * The house GPS for the intake forms (gpsCapture.ts). One tap: the in-app line, then the
 * browser's own prompt; the first reading is taken at once and improved for up to 15 s;
 * no reading means "Drop a pin on the house".
 *
 *   asking    the line "Welile needs your location to confirm the house", waiting for a reading
 *   improving a reading is in; better ones may still come
 *   done      the watch is over (a reading, or a pin)
 *   pin       no reading: the map to drop a pin on
 */
export type GpsPhase = 'idle' | 'asking' | 'improving' | 'done' | 'pin';

export function useGpsCapture(handlers: {
  /** Each reading: the first one (first = true), then each better one. */
  onFix?: (fix: GpsFix, first: boolean) => void;
  /** Why there is no reading; the pin map is then shown. */
  onFail?: (code: GpsFailCode) => void;
  /** The pin the agent dropped. */
  onPin?: (fix: GpsFix) => void;
} = {}) {
  const [phase, setPhase] = useState<GpsPhase>('idle');
  const [location, setLocation] = useState<GpsFix | null>(null);
  const [failure, setFailure] = useState<GpsFailCode | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => () => stop.current?.(), []);

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
          setPhase('pin');
          h.current.onFail?.(code);
        } else {
          setPhase('done');
        }
      },
    });
  }, []);

  /** Opens the pin map without trying the phone's location (e.g. the agent chose it). */
  const showPin = useCallback(() => { stop.current?.(); setPhase('pin'); }, []);

  const dropPin = useCallback((lat: number, lng: number) => {
    const fix: GpsFix = { lat, lng, accuracy: null, source: 'pin' };
    setLocation(fix);
    setPhase('done');
    h.current.onPin?.(fix);
  }, []);

  return { phase, location, failure, capture, showPin, dropPin };
}
export type GpsCaptureState = ReturnType<typeof useGpsCapture>;
