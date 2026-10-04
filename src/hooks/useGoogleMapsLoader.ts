/// <reference types="google.maps" />
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

const BROWSER_KEY = import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY as string | undefined;
const TRACKING_ID = import.meta.env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID as string | undefined;

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

// Module-level singletons so the script loads only once across the whole app.
let scriptPromise: Promise<void> | null = null;

// Resolved once: a custom Google Maps browser key configured by a manager
// (used so the map works on custom domains the managed key doesn't allow).
// Falls back to the Lovable-managed connector key when none is set.
let resolvedKey: string | undefined;
let keyPromise: Promise<string | undefined> | null = null;

async function resolveBrowserKey(): Promise<string | undefined> {
  if (resolvedKey !== undefined) return resolvedKey;
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    let custom: string | undefined;
    try {
      // Scoped accessor — the map_config table is no longer world-readable
      // through the Data API; this RPC returns only the browser key and only
      // to signed-in callers.
      const { data } = await supabase.rpc('get_maps_browser_key');
      const k = typeof data === 'string' ? data.trim() : undefined;
      if (k) custom = k;
    } catch {
      // Network/RLS failure — fall back to the managed key.
    }
    resolvedKey = custom || BROWSER_KEY;
    return resolvedKey;
  })();
  return keyPromise;
}

declare global {
  interface Window {
    __welileInitGoogleMaps?: () => void;
    gm_authFailure?: () => void;
    google?: typeof google;
  }
}

// Google calls this global on key/referrer auth failures (e.g.
// RefererNotAllowedMapError, InvalidKeyMapError). The JS API still "loads"
// in that case, so without this hook the map renders as a greyed-out broken
// widget. We flip a flag so the UI can show the proper fallback instead.
let authFailed = false;
const authFailureListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.gm_authFailure = () => {
    authFailed = true;
    authFailureListeners.forEach((fn) => fn());
  };
}

function loadGoogleMaps(): Promise<void> {
  if (typeof window !== 'undefined' && window.google?.maps) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = (async () => {
    const key = await resolveBrowserKey();
    if (!key) throw new Error('Google Maps key missing');
    await new Promise<void>((resolve, reject) => {
    window.__welileInitGoogleMaps = () => resolve();
    const script = document.createElement('script');
    const params = new URLSearchParams({
        key,
      loading: 'async',
      callback: '__welileInitGoogleMaps',
      libraries: 'marker',
    });
    if (TRACKING_ID) params.set('channel', TRACKING_ID);
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
    });
  })();
  return scriptPromise;
}

/**
 * Loads the Google Maps JavaScript API once (async, with callback) and reports
 * readiness. The browser key is referrer-restricted and safe to embed.
 */
export function useGoogleMapsLoader(enabled = true) {
  const [state, setState] = useState<LoadState>(() =>
    authFailed ? 'error' : typeof window !== 'undefined' && window.google?.maps ? 'ready' : 'idle'
  );
  // Distinguishes a domain/key rejection (Google's gm_authFailure, i.e.
  // RefererNotAllowedMapError / InvalidKeyMapError) from a plain script load
  // failure, so the UI can explain what actually went wrong.
  const [reason, setReason] = useState<'referrer' | 'load' | null>(() => (authFailed ? 'referrer' : null));

  useEffect(() => {
    if (!enabled || state === 'ready' || state === 'error') return;
    let cancelled = false;
    setState('loading');
    const onAuthFail = () => { if (!cancelled) { setReason('referrer'); setState('error'); } };
    authFailureListeners.add(onAuthFail);
    if (authFailed) onAuthFail();
    loadGoogleMaps()
      .then(() => { if (!cancelled) setState('ready'); })
      .catch(() => { if (!cancelled) { setReason((r) => r ?? 'load'); setState('error'); } });
    return () => { cancelled = true; authFailureListeners.delete(onAuthFail); };
  }, [enabled, state]);

  return {
    isReady: state === 'ready',
    isLoading: state === 'loading',
    isError: state === 'error',
    /** 'referrer' = key not authorised for this domain, 'load' = script failed. */
    errorReason: reason,
    // We may have a managed key OR a manager-configured custom key; treat the
    // presence of either as "has a key". The custom key is resolved async, so
    // only report missing when there is also no managed fallback.
    hasKey: !!BROWSER_KEY || resolvedKey !== undefined,
  };
}