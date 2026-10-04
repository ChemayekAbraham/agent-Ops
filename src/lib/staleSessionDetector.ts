/**
 * Stale-session detector.
 *
 * Some browsers (especially installed PWAs / iOS home-screen icons and long-lived
 * tabs on flaky networks) end up holding a Supabase access token that the auth
 * server no longer accepts. The tell-tale server responses are:
 *
 *   - HTTP 401 `bad_jwt`
 *   - HTTP 403 `invalid claim: missing sub claim`
 *
 * When we see one of those, we:
 *   1. Force a token refresh via `supabase.auth.refreshSession()`.
 *   2. If the refresh succeeds, dispatch `welile:session-rehydrated` so app
 *      state (React Query, wallet balances, etc.) can invalidate itself.
 *   3. If the refresh fails, wipe all cached auth storage, sign out, and send
 *      the user to `/auth`.
 *
 * The detector is throttled to at most one attempt every 30 seconds to avoid
 * refresh storms if many concurrent requests fail at once.
 */
import { supabase } from '@/integrations/supabase/client';
import { clearAllAuthStorage, clearSessionCache } from '@/lib/sessionCache';

const STALE_TOKEN_MARKERS = [
  'bad_jwt',
  'missing sub claim',
  'missing sub',
  'invalid claim',
  'jwt expired',
  'jwt malformed',
  'token is expired',
];

const REHYDRATE_EVENT = 'welile:session-rehydrated';
const SIGNED_OUT_EVENT = 'welile:session-forced-signout';
const RECOVERY_REQUIRED_EVENT = 'welile:auth-recovery-required';
const THROTTLE_MS = 30_000;
const RECOVERY_FAILURE_THRESHOLD = 3;
const RECOVERY_WINDOW_MS = 5 * 60_000;

let installed = false;
let inFlight: Promise<void> | null = null;
let lastAttempt = 0;
let forcedSignOut = false;
let recoveryFailures: number[] = [];
let recoveryDispatched = false;
/**
 * Depth counter for "auth-critical sections" — long user actions that must never
 * be interrupted by a forced sign-out (camera capture → proof upload is the
 * canonical case: returning from the phone camera often resumes the page with a
 * momentarily expired token and no network for a second or two).
 */
let criticalDepth = 0;
/**
 * Timestamp until which a forced sign-out is suppressed regardless of depth.
 * Used for two situations that are indistinguishable from a dead session but
 * are in fact purely environmental:
 *   1. The camera / file picker is open (the page is about to be backgrounded
 *      and resumed, often with an expired token and no radio).
 *   2. The page has just become visible again after being backgrounded — the
 *      network stack typically needs a few seconds before a token refresh can
 *      succeed.
 */
let suppressUntil = 0;
const RESUME_GRACE_MS = 25_000;
/** Longest a camera/file-picker arm may keep sign-out suppressed. */
const ARM_MAX_MS = 5 * 60_000;

/**
 * Arm sign-out suppression for a bounded window WITHOUT needing a matching
 * `end` call. Call this the moment a native picker/camera is opened: the page
 * may be discarded and resumed before any `onChange` handler runs, so a
 * depth counter alone can never cover that gap.
 */
export function armAuthCriticalSection(ms = 90_000): void {
  const window_ = Math.min(Math.max(ms, 0), ARM_MAX_MS);
  suppressUntil = Math.max(suppressUntil, Date.now() + window_);
}

/** Clear an armed suppression window early (e.g. the picker was cancelled). */
export function disarmAuthCriticalSection(): void {
  suppressUntil = 0;
}

/** Mark the start of an operation that must not be interrupted by a sign-out. */
export function beginAuthCriticalSection(): void {
  criticalDepth += 1;
}

/** Mark the end of an auth-critical operation. */
export function endAuthCriticalSection(): void {
  criticalDepth = Math.max(0, criticalDepth - 1);
}

/** True while the app must not be booted to /auth (offline, backgrounded, or busy). */
export function isSignOutSuppressed(): boolean {
  if (criticalDepth > 0) return true;
  if (Date.now() < suppressUntil) return true;
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
  } catch {
    /* ignore */
  }
  return false;
}

function recordAuthFailure(reason: string): boolean {
  const now = Date.now();
  recoveryFailures = recoveryFailures.filter((t) => now - t < RECOVERY_WINDOW_MS);
  recoveryFailures.push(now);
  if (recoveryFailures.length >= RECOVERY_FAILURE_THRESHOLD && !recoveryDispatched) {
    recoveryDispatched = true;
    try {
      window.dispatchEvent(
        new CustomEvent(RECOVERY_REQUIRED_EVENT, {
          detail: { reason, failures: recoveryFailures.length },
        }),
      );
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function isSupabaseUrl(url: string): boolean {
  try {
    const base = (import.meta as any).env?.VITE_SUPABASE_URL as string | undefined;
    if (base && url.startsWith(base)) return true;
  } catch {
    /* ignore */
  }
  return /\.supabase\.co\/|\.supabase\.in\/|\.lovable\.cloud\//.test(url);
}

function matchesStaleToken(text: string, status: number): boolean {
  if (status !== 401 && status !== 403) return false;
  const lower = (text || '').toLowerCase();
  return STALE_TOKEN_MARKERS.some((marker) => lower.includes(marker));
}

async function handleStaleToken(reason: string): Promise<void> {
  if (forcedSignOut) return;
  const now = Date.now();
  if (now - lastAttempt < THROTTLE_MS) return;
  lastAttempt = now;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      console.warn('[StaleSession] Detected stale token —', reason, '— forcing refresh');
      // Retry the refresh a few times before concluding the session is dead:
      // the first attempt right after the page resumes (camera/file picker,
      // app switch) very often fails purely because the radio is still down.
      let data: Awaited<ReturnType<typeof supabase.auth.refreshSession>>['data'] | null = null;
      let error: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await supabase.auth.refreshSession();
        data = res.data;
        error = res.error;
        if (!res.error && res.data.session) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }

      if (!error && data?.session) {
        console.info('[StaleSession] Refresh succeeded — rehydrating app state');
        // Success — reset the failure counter.
        recoveryFailures = [];
        recoveryDispatched = false;
        try {
          window.dispatchEvent(
            new CustomEvent(REHYDRATE_EVENT, { detail: { userId: data.session.user.id } }),
          );
        } catch {
          /* ignore */
        }
        return;
      }

      // A refresh that failed because the *network* failed (typical for the
      // first second or two after the phone camera closes and the page
      // resumes) says nothing about the validity of the session. Never sign
      // out on that — let a later attempt decide.
      const errMsg = ((error as any)?.message || '').toLowerCase();
      if (
        !errMsg ||
        errMsg.includes('failed to fetch') ||
        errMsg.includes('networkerror') ||
        errMsg.includes('network request failed') ||
        errMsg.includes('load failed') ||
        errMsg.includes('timeout') ||
        errMsg.includes('aborted')
      ) {
        console.warn('[StaleSession] Refresh failed for network reasons — keeping session');
        lastAttempt = 0;
        return;
      }

      // Never boot the user mid-action (proof upload), while offline, or while
      // the page is backgrounded — those refresh failures are environmental,
      // not a dead session. Allow a later attempt instead.
      if (isSignOutSuppressed()) {
        console.warn('[StaleSession] Refresh failed but sign-out is suppressed (busy/offline/hidden) — keeping session');
        lastAttempt = 0;
        return;
      }

      // Refresh failed → the session is truly dead. Sign out cleanly.
      forcedSignOut = true;
      recordAuthFailure(reason);
      console.warn('[StaleSession] Refresh failed — signing out:', (error as any)?.message);
      try {
        window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT, { detail: { reason } }));
      } catch {
        /* ignore */
      }
      try {
        clearSessionCache();
        clearAllAuthStorage();
      } catch {
        /* ignore */
      }
      try {
        await supabase.auth.signOut();
      } catch {
        /* ignore */
      }

      // Redirect once, preserving the intended path so the user returns after login.
      try {
        const next = window.location.pathname + window.location.search;
        const alreadyOnAuth = window.location.pathname.startsWith('/auth');
        if (!alreadyOnAuth) {
          const url = `/auth?next=${encodeURIComponent(next)}&reason=stale_session`;
          window.location.replace(url);
        }
      } catch {
        /* ignore */
      }
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Installs a global `fetch` interceptor that watches Supabase responses for
 * stale-token errors. Safe to call multiple times — installs at most once.
 */
export function installStaleSessionDetector(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  // Resume grace: whenever the page comes back to the foreground (returning
  // from the camera, gallery, or an app switch) give the network a few seconds
  // before any refresh failure is allowed to end the session.
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        suppressUntil = Math.max(suppressUntil, Date.now() + RESUME_GRACE_MS);
        // Allow an immediate fresh refresh attempt after resuming.
        lastAttempt = 0;
      }
    });
    window.addEventListener('pageshow', () => {
      suppressUntil = Math.max(suppressUntil, Date.now() + RESUME_GRACE_MS);
      lastAttempt = 0;
    });
  } catch {
    /* ignore */
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);

    try {
      if (response.status !== 401 && response.status !== 403) return response;

      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : '';
      if (!url || !isSupabaseUrl(url)) return response;

      // Clone so the caller still sees an untouched body.
      const cloned = response.clone();
      const bodyText = await cloned.text().catch(() => '');

      if (matchesStaleToken(bodyText, response.status)) {
        recordAuthFailure(`http_${response.status}`);
        // Fire-and-forget — don't block the caller. The caller will surface
        // the original error and the detector will refresh/redirect in the
        // background.
        void handleStaleToken(`http_${response.status}:${url.split('?')[0]}`);
      }
    } catch {
      /* never let the detector break real requests */
    }

    return response;
  };

  // Also listen for `onAuthStateChange` TOKEN_REFRESHED failures reported as
  // `SIGNED_OUT` — normal signOut is fine, but a SIGNED_OUT that fires while
  // the user is deep in the app (no explicit user action) usually means the
  // refresh token was rejected. That path is already handled by the fetch
  // interceptor above catching the /token 401, so no extra listener needed.
}

export const STALE_SESSION_EVENTS = {
  rehydrated: REHYDRATE_EVENT,
  forcedSignOut: SIGNED_OUT_EVENT,
  recoveryRequired: RECOVERY_REQUIRED_EVENT,
};