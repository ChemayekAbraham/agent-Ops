import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Route-scoped location controller for /dashboard/funder-new.
 *
 * One bounded acquisition shared by the map, the read queries, distance labels
 * and the calculator. Precise coordinates stay in memory for this page only:
 * they are never written to storage, analytics, profiles or logs.
 */

export type FunderNewPermission = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown';
export type FunderNewLocationStatus = 'idle' | 'locating' | 'ready' | 'error';

export interface FunderNewCoords {
  lat: number;
  lng: number;
  accuracyM: number | null;
  /** epoch ms of acquisition, used only for the freshness check. */
  at: number;
}

export interface FunderNewLocationController {
  permission: FunderNewPermission;
  status: FunderNewLocationStatus;
  coords: FunderNewCoords | null;
  error: string | null;
  /** True while the automatic (already-granted) acquisition is running. */
  autoLocating: boolean;
  /** Explicit user action — the only path allowed to open the browser prompt. */
  request: () => void;
  /** Re-acquire when permission is still granted. */
  refresh: () => void;
  dismissError: () => void;
}

const FRESHNESS_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 12_000;

function isSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  if (!('geolocation' in navigator)) return false;
  // Browsers refuse geolocation outside a secure context.
  return window.isSecureContext !== false;
}

function messageFor(code: number | undefined): string {
  if (code === 1) return 'Location permission was turned off, so homes are not sorted by distance.';
  if (code === 2) return 'Your location could not be worked out just now. You can still search by area.';
  if (code === 3) return 'Finding your location took too long. You can retry or search by area.';
  return 'Your location is unavailable right now. You can still search by area.';
}

export function useFunderNewLocation(): FunderNewLocationController {
  const supported = isSupported();
  const [permission, setPermission] = useState<FunderNewPermission>(supported ? 'unknown' : 'unsupported');
  const [status, setStatus] = useState<FunderNewLocationStatus>('idle');
  const [coords, setCoords] = useState<FunderNewCoords | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoLocating, setAutoLocating] = useState(false);

  const inFlight = useRef(false);
  const coordsAt = useRef<number>(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const acquire = useCallback(
    (auto: boolean) => {
      if (!supported || inFlight.current) return;
      if (auto && coordsAt.current > 0 && Date.now() - coordsAt.current < FRESHNESS_MS) return;

      inFlight.current = true;
      setStatus('locating');
      setError(null);
      if (auto) setAutoLocating(true);

      navigator.geolocation.getCurrentPosition(
        (position) => {
          inFlight.current = false;
          if (!mounted.current) return;
          coordsAt.current = Date.now();
          setCoords({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
            at: coordsAt.current,
          });
          setStatus('ready');
          setAutoLocating(false);
        },
        (positionError) => {
          inFlight.current = false;
          if (!mounted.current) return;
          setStatus('error');
          setAutoLocating(false);
          setError(messageFor(positionError?.code));
        },
        { enableHighAccuracy: false, timeout: TIMEOUT_MS, maximumAge: FRESHNESS_MS },
      );
    },
    [supported],
  );

  // Inspect the browser's real permission state. A granted state — and only a
  // granted state — triggers an automatic acquisition with no extra app modal.
  useEffect(() => {
    if (!supported) {
      setPermission('unsupported');
      return;
    }
    const permissionsApi = navigator.permissions;
    if (!permissionsApi?.query) {
      // No way to read the real state: fall back to the explicit action rather
      // than guessing from a stored flag.
      setPermission('unknown');
      return;
    }

    let statusHandle: PermissionStatus | null = null;
    let cancelled = false;

    const apply = (state: PermissionState) => {
      if (cancelled || !mounted.current) return;
      if (state === 'granted') {
        setPermission('granted');
        acquire(true);
        return;
      }
      if (state === 'denied') {
        setPermission('denied');
        setCoords(null);
        coordsAt.current = 0;
        setStatus('idle');
        return;
      }
      setPermission('prompt');
    };

    permissionsApi
      .query({ name: 'geolocation' as PermissionName })
      .then((handle) => {
        if (cancelled) return;
        statusHandle = handle;
        apply(handle.state);
        handle.onchange = () => apply(handle.state);
      })
      .catch(() => {
        if (!cancelled && mounted.current) setPermission('unknown');
      });

    return () => {
      cancelled = true;
      if (statusHandle) statusHandle.onchange = null;
    };
  }, [supported, acquire]);

  const request = useCallback(() => {
    if (!supported) {
      setStatus('error');
      setError('This browser cannot share your location. You can search by area instead.');
      return;
    }
    acquire(false);
  }, [acquire, supported]);

  const refresh = useCallback(() => {
    coordsAt.current = 0;
    acquire(false);
  }, [acquire]);

  const dismissError = useCallback(() => setError(null), []);

  return { permission, status, coords, error, autoLocating, request, refresh, dismissError };
}

export default useFunderNewLocation;
