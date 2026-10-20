// Bounds Supabase token requests and server-side identity checks.
//
// supabase-js holds a single auth lock while it refreshes the session, and
// every getSession(), every query and signInWithPassword() waits on that lock.
// On a poor mobile connection the refresh request can hang with no response
// at all, and fetch has no timeout, so the lock was held indefinitely: the
// dashboard never got its session (the 8s init watchdog then sent the person
// to /auth), and the Sign in button on /auth spun forever because it was
// queued behind the same hung refresh. login_phase_events: getSession p95
// 12.8s on the traces that hit auth.init.timeout_forced (132 users, 3 days to
// 2026-10-19).
//
// Aborting a token request after TOKEN_REQUEST_TIMEOUT_MS turns the hang into
// a retryable network error: supabase-js retries with backoff for up to 30s
// and then releases the lock, so sign-in and the session check always finish.
//
// IMPORTANT: no imports, so it can be loaded before the Supabase client is
// created (imported right after ephemeralGuard in main.tsx). supabase-js looks
// up the global fetch at call time, so wrapping window.fetch here is enough.

export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

function isBlockingAuthRequest(url: string): boolean {
  try {
    const path = new URL(url, window.location.origin).pathname;
    return path === '/auth/v1/token' || path === '/auth/v1/user';
  } catch {
    return false;
  }
}

// getUser() holds the same lock as refresh. A hung /user request must also
// release it so dashboard queries and subsequent sign-in can proceed.
export function withAuthFetchTimeout(originalFetch: typeof fetch): typeof fetch {

    return (input: RequestInfo | URL, init?: RequestInit) => {
      let url = '';
      try {
        url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input instanceof Request
                ? input.url
                : '';
      } catch {
        /* ignore */
      }
      if (!url || !isBlockingAuthRequest(url)) return originalFetch(input, init);

      const controller = new AbortController();
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const abortFromCaller = () => controller.abort();
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
      return originalFetch(input, { ...init, signal: controller.signal }).finally(() => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', abortFromCaller);
      });
    };
}

try {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function' && typeof AbortController === 'function') {
    window.fetch = withAuthFetchTimeout(window.fetch.bind(window));
  }
} catch {
  /* never let the wrapper break boot */
}

