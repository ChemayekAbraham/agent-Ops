import { useEffect, useState } from 'react';

export type PreflightCheckKey =
  | 'manifest'
  | 'appleTouchIcon'
  | 'serviceWorker'
  | 'signedDownload';

export interface PreflightCheck {
  key: PreflightCheckKey;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface PreflightResult {
  ready: boolean;
  /**
   * True when the checks ran but at least one failed. The install card stays
   * visible in this state (degraded), it is never hidden — a slow or metered
   * mobile connection routinely fails these checks even though installing works.
   */
  degraded: boolean;
  loading: boolean;
  checks: PreflightCheck[];
  ranAt: number | null;
}

const CACHE_KEY = 'welile_install_preflight_v1';
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchOk(url: string, init?: RequestInit): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

async function checkManifest(): Promise<PreflightCheck> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  const href = link?.href || '/manifest.webmanifest';
  const res = await fetch(href, { cache: 'no-store' });
  if (!res.ok) {
    return { key: 'manifest', label: 'Web app manifest', ok: false, detail: `HTTP ${res.status}` };
  }
  try {
    const json = await res.json();
    const hasIcons = Array.isArray(json.icons) && json.icons.length > 0;
    const hasDisplay = typeof json.display === 'string';
    if (!hasIcons || !hasDisplay) {
      return { key: 'manifest', label: 'Web app manifest', ok: false, detail: 'Missing icons or display' };
    }
    return { key: 'manifest', label: 'Web app manifest', ok: true, detail: json.name || json.short_name };
  } catch (e) {
    return { key: 'manifest', label: 'Web app manifest', ok: false, detail: 'Invalid JSON' };
  }
}

async function checkAppleTouchIcon(): Promise<PreflightCheck> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  const href = link?.href || '/apple-touch-icon.png';
  const r = await fetchOk(href, { method: 'GET' });
  return { key: 'appleTouchIcon', label: 'Apple touch icon', ok: r.ok, detail: r.detail };
}

async function checkServiceWorker(): Promise<PreflightCheck> {
  if (!('serviceWorker' in navigator)) {
    return { key: 'serviceWorker', label: 'Service worker support', ok: false, detail: 'Not supported by browser' };
  }
  // Confirm the SW script is reachable (push worker at /sw.js).
  const scriptCheck = await fetchOk('/sw.js');
  if (!scriptCheck.ok) {
    return {
      key: 'serviceWorker',
      label: 'Service worker script',
      ok: false,
      detail: scriptCheck.detail || 'Unreachable',
    };
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    const hasReg = regs.some((r) => (r.active || r.installing || r.waiting) != null);
    return {
      key: 'serviceWorker',
      label: 'Service worker',
      ok: true,
      detail: hasReg ? 'Registered' : 'Available (not yet registered)',
    };
  } catch (e) {
    return { key: 'serviceWorker', label: 'Service worker', ok: false, detail: (e as Error).message };
  }
}

async function checkSignedDownload(): Promise<PreflightCheck> {
  // Confirms the browser can pull a signed/CDN binary asset from the current
  // origin — the same path an install / cached shell would rely on. We hit
  // the app icon with a cache-busting query so proxies/service workers can't
  // mask a real network failure.
  const url = `/icon-192.png?preflight=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      return { key: 'signedDownload', label: 'Asset download', ok: false, detail: `HTTP ${res.status}` };
    }
    const blob = await res.blob();
    if (blob.size < 100) {
      return { key: 'signedDownload', label: 'Asset download', ok: false, detail: 'Empty response' };
    }
    return { key: 'signedDownload', label: 'Asset download', ok: true, detail: `${Math.round(blob.size / 1024)} KB` };
  } catch (e) {
    return { key: 'signedDownload', label: 'Asset download', ok: false, detail: (e as Error).message };
  }
}

export async function runInstallPreflight(): Promise<PreflightCheck[]> {
  const results = await Promise.all([
    checkManifest().catch((e) => ({
      key: 'manifest' as const,
      label: 'Web app manifest',
      ok: false,
      detail: (e as Error).message,
    })),
    checkAppleTouchIcon().catch((e) => ({
      key: 'appleTouchIcon' as const,
      label: 'Apple touch icon',
      ok: false,
      detail: (e as Error).message,
    })),
    checkServiceWorker().catch((e) => ({
      key: 'serviceWorker' as const,
      label: 'Service worker',
      ok: false,
      detail: (e as Error).message,
    })),
    checkSignedDownload().catch((e) => ({
      key: 'signedDownload' as const,
      label: 'Asset download',
      ok: false,
      detail: (e as Error).message,
    })),
  ]);
  return results;
}

function readCache(): { checks: PreflightCheck[]; ranAt: number } | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { checks: PreflightCheck[]; ranAt: number };
    if (!parsed?.ranAt || Date.now() - parsed.ranAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(checks: PreflightCheck[], ranAt: number) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ checks, ranAt }));
  } catch {
    /* ignore quota */
  }
}

export function useInstallPreflight(enabled: boolean = true): PreflightResult & { rerun: () => void } {
  const [state, setState] = useState<PreflightResult>(() => {
    const cached = typeof window !== 'undefined' ? readCache() : null;
    if (cached) {
      return {
        checks: cached.checks,
        ranAt: cached.ranAt,
        loading: false,
        ready: cached.checks.every((c) => c.ok),
        degraded: cached.checks.some((c) => !c.ok),
      };
    }
    return { checks: [], ranAt: null, loading: enabled, ready: false, degraded: false };
  });

  const run = async () => {
    setState((s) => ({ ...s, loading: true }));
    const checks = await runInstallPreflight();
    const ranAt = Date.now();
    const allOk = checks.every((c) => c.ok);
    // Only a passing result is cached. Caching a failure would keep the card
    // suppressed/degraded for the rest of the session even after the network
    // recovers.
    if (allOk) writeCache(checks, ranAt);
    setState({ checks, ranAt, loading: false, ready: allOk, degraded: !allOk });
  };

  useEffect(() => {
    if (!enabled) return;
    if (state.ranAt && Date.now() - state.ranAt < CACHE_TTL_MS) return;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Re-check when the device comes back online so a connection blip does not
  // leave the card stuck in the degraded state.
  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => {
      void run();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { ...state, rerun: run };
}