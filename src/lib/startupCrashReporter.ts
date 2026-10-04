/**
 * Startup crash reporter.
 *
 * Runs when the app FAILS TO START (bundle load error, blank-page guard, or the
 * inline out-of-date-browser watchdog). At that point React never mounted, so
 * the normal `errorReporting` pipeline and its boundaries are unavailable.
 *
 * This module is intentionally tiny and dependency-free at import time: it only
 * dynamically imports the Supabase client when it actually has something to
 * report, so it never weighs down the critical startup path. It writes to
 * `public_error_logs` (anon-insertable) because a startup crash usually happens
 * before the user is authenticated.
 *
 * The payload captures the raw user agent plus a set of "missing feature"
 * checks so we can tell, from the data alone, whether an old browser lacking a
 * given API is the reason the app couldn't boot.
 */

/** Feature-detection probes. Each returns true when the feature IS present. */
function runFeatureChecks(): { supported: string[]; missing: string[] } {
  const checks: Record<string, () => boolean> = {
    Promise: () => typeof Promise !== 'undefined',
    fetch: () => typeof fetch !== 'undefined',
    Map: () => typeof Map !== 'undefined',
    Set: () => typeof Set !== 'undefined',
    WeakMap: () => typeof WeakMap !== 'undefined',
    Symbol: () => typeof Symbol !== 'undefined',
    Proxy: () => typeof Proxy !== 'undefined',
    'Object.assign': () => typeof Object.assign === 'function',
    'Object.hasOwn': () => typeof (Object as any).hasOwn === 'function',
    'Array.from': () => typeof Array.from === 'function',
    'Array.prototype.at': () => typeof (Array.prototype as any).at === 'function',
    'Array.prototype.flat': () => typeof (Array.prototype as any).flat === 'function',
    'Array.prototype.flatMap': () => typeof (Array.prototype as any).flatMap === 'function',
    'String.prototype.replaceAll': () =>
      typeof (String.prototype as any).replaceAll === 'function',
    'String.prototype.at': () => typeof (String.prototype as any).at === 'function',
    'Promise.allSettled': () => typeof (Promise as any).allSettled === 'function',
    'Promise.any': () => typeof (Promise as any).any === 'function',
    BigInt: () => typeof BigInt !== 'undefined',
    Intl: () => typeof Intl !== 'undefined',
    structuredClone: () => typeof (globalThis as any).structuredClone === 'function',
    IntersectionObserver: () => typeof (window as any).IntersectionObserver !== 'undefined',
    ResizeObserver: () => typeof (window as any).ResizeObserver !== 'undefined',
    MutationObserver: () => typeof (window as any).MutationObserver !== 'undefined',
    localStorage: () => {
      try {
        return typeof window.localStorage !== 'undefined';
      } catch {
        return false; // blocked in private mode / cookies disabled
      }
    },
    indexedDB: () => {
      try {
        return typeof window.indexedDB !== 'undefined';
      } catch {
        return false;
      }
    },
    serviceWorker: () => 'serviceWorker' in navigator,
    'CSS.supports': () => typeof (window as any).CSS?.supports === 'function',
    'backdrop-filter': () => {
      try {
        return (
          !!(window as any).CSS?.supports &&
          ((window as any).CSS.supports('backdrop-filter', 'blur(1px)') ||
            (window as any).CSS.supports('-webkit-backdrop-filter', 'blur(1px)'))
        );
      } catch {
        return false;
      }
    },
    WebGL: () => {
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
      } catch {
        return false;
      }
    },
  };

  const supported: string[] = [];
  const missing: string[] = [];
  for (const [name, probe] of Object.entries(checks)) {
    let ok = false;
    try {
      ok = probe() === true;
    } catch {
      ok = false;
    }
    (ok ? supported : missing).push(name);
  }
  return { supported, missing };
}

/** Rough device/browser summary — no library, best-effort. */
function summarizeDevice() {
  try {
    const ua = navigator.userAgent || '';
    const nav = navigator as any;
    return {
      os: /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'iOS'
          : /Windows/i.test(ua)
            ? 'Windows'
            : /Mac OS X/i.test(ua)
              ? 'macOS'
              : /Linux/i.test(ua)
                ? 'Linux'
                : 'unknown',
      language: navigator.language ?? null,
      online: navigator.onLine ?? null,
      deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      hardwareConcurrency:
        typeof navigator.hardwareConcurrency === 'number'
          ? navigator.hardwareConcurrency
          : null,
      effectiveType: nav.connection?.effectiveType ?? null,
      saveData: nav.connection?.saveData ?? null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      pixelRatio: window.devicePixelRatio ?? null,
    };
  } catch {
    return {};
  }
}

// Only report a startup crash once per page load — the failure paths can fire
// more than once (blank-page guard runs twice, plus the load catch).
let reported = false;

export interface StartupCrashInput {
  /** Where the failure was detected. */
  reason: string;
  error?: unknown;
}

/**
 * Report an app-failed-to-start crash. Always resolves — never throws.
 * Captures the user agent and missing-feature checks so old-browser failures
 * are diagnosable from the logged data alone.
 */
export async function reportStartupCrash(input: StartupCrashInput): Promise<void> {
  if (reported) return;
  reported = true;

  try {
    const { supported, missing } = runFeatureChecks();
    const err = input.error;
    const errorMessage =
      err instanceof Error ? err.message : err != null ? String(err) : null;
    const errorStack = err instanceof Error ? err.stack ?? null : null;

    const payload = {
      pathname:
        typeof window !== 'undefined'
          ? window.location.pathname + window.location.search
          : null,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      error_message: `[startup-crash:${input.reason}] ${errorMessage ?? 'app failed to start'}`,
      error_stack: errorStack,
      metadata: {
        source: 'startup-crash-reporter',
        reason: input.reason,
        missing_features: missing,
        supported_features: supported,
        missing_feature_count: missing.length,
        device: summarizeDevice(),
        href: typeof window !== 'undefined' ? window.location.href : null,
        reported_at: new Date().toISOString(),
      },
    };

    // Console first — guarantees a trace even if the network insert fails.
    console.error('[startupCrash]', payload.error_message, {
      missing_features: missing,
    });

    const { supabase } = await import('@/integrations/supabase/client');
    await supabase.from('public_error_logs').insert(payload as any);
  } catch {
    // Reporting must never throw — swallow everything.
  }
}