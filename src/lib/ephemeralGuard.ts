// Runs ONCE, synchronously, as an import side-effect at the very top of the
// app boot — BEFORE the Supabase client or session cache read any stored token.
//
// If the previous login chose NOT to "remember this device" (ephemeral), and
// this is a fresh cold start of the browser (no live sessionStorage marker),
// we drop the stored auth token so the user is required to sign in again
// (OTP / password). Same-tab reloads keep the session because the marker
// survives reloads but not a full browser/tab close.
//
// iOS NOTE: WebKit (Safari AND Chrome on iPhone) aggressively kills
// backgrounded tabs and does NOT reliably restore sessionStorage when the
// page reloads. Relying on the sessionStorage marker alone therefore logged
// iOS users out after only a few minutes in the background. To distinguish a
// real "browser was closed" cold start from an iOS tab-kill, we also keep a
// last-active heartbeat in localStorage (which survives tab kills). The token
// is only dropped when BOTH signals say the browser was closed: no live
// sessionStorage marker AND the heartbeat is older than the grace window.
//
// IMPORTANT: this module must have NO imports so it executes before any other
// module's top-level code (it is imported first in main.tsx).

const EPHEMERAL_SESSION_KEY = 'welile_ephemeral_session';
const SESSION_ACTIVE_KEY = 'welile_session_active';
// supabase-js stores the session under `sb-<project-ref>-auth-token`; the ref comes from the configured URL so the key
// follows the project. The previous project's key is kept in the list so it is cleared as well.
const SUPABASE_PROJECT_REF = (() => {
  try { return new URL(String(import.meta.env.VITE_SUPABASE_URL)).hostname.split('.')[0]; } catch { return ''; }
})();
const LEGACY_AUTH_TOKEN_KEY = 'sb-wirntoujqoyjobfhyelc-auth-token';
const CURRENT_AUTH_TOKEN_KEY = SUPABASE_PROJECT_REF ? `sb-${SUPABASE_PROJECT_REF}-auth-token` : '';
const SUPABASE_AUTH_TOKEN_KEYS = [CURRENT_AUTH_TOKEN_KEY, LEGACY_AUTH_TOKEN_KEY].filter(Boolean);
const SESSION_CACHE_KEY = 'welile_session_cache';
const ROLES_CACHE_KEY = 'welile_roles_cache';
const LAST_ACTIVE_KEY = 'welile_last_active_at';
// If the app was alive within this window, treat a missing sessionStorage
// marker as an iOS tab-kill (keep the session), not a browser close.
const COLD_START_GRACE_MS = 60 * 60 * 1000; // 1 hour

// After the move to the new project, a browser can still hold a session issued by the PREVIOUS project. Its tokens are
// signed with that project's keys, so the current project answers 401 to every request and cannot refresh them, while
// the cached session/roles make the app look signed in (a dashboard shell whose every call fails). Drop any stored
// session whose access token was not issued by the current project, together with the cached session and roles, so
// the user lands on a clean sign-in. A session issued by the current project is never touched.
function storedSessionIsForeign(raw: string | null, expectedIssuer: string): boolean {
  if (!raw) return false;
  try {
    const accessToken = JSON.parse(raw)?.access_token;
    if (typeof accessToken !== 'string') return false;
    let part = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (part.length % 4) part += '=';
    const issuer = JSON.parse(atob(part))?.iss;
    return typeof issuer === 'string' && issuer !== expectedIssuer;
  } catch { return false; }
}
try {
  const expectedIssuer = `${new URL(String(import.meta.env.VITE_SUPABASE_URL)).origin}/auth/v1`;
  let dropped = false;
  for (const key of SUPABASE_AUTH_TOKEN_KEYS) {
    if (storedSessionIsForeign(localStorage.getItem(key), expectedIssuer)) { localStorage.removeItem(key); dropped = true; }
  }
  if (dropped) {
    localStorage.removeItem(SESSION_CACHE_KEY);
    localStorage.removeItem(ROLES_CACHE_KEY);
  }
} catch { /* storage unavailable or no configured URL */ }

try {
  const ephemeral = localStorage.getItem(EPHEMERAL_SESSION_KEY) === 'true';
  const sessionLive = sessionStorage.getItem(SESSION_ACTIVE_KEY) === '1';
  const lastActive = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || '0', 10);
  const recentlyActive =
    Number.isFinite(lastActive) && lastActive > 0 && Date.now() - lastActive < COLD_START_GRACE_MS;

  if (ephemeral && !sessionLive && !recentlyActive) {
    // Cold start after the browser was fully closed → require fresh sign-in.
    SUPABASE_AUTH_TOKEN_KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem(SESSION_CACHE_KEY);
    localStorage.removeItem(ROLES_CACHE_KEY);
  }

  // Mark this browsing session as live for the rest of its lifetime.
  sessionStorage.setItem(SESSION_ACTIVE_KEY, '1');

  // Heartbeat: keep the last-active stamp fresh while the app is open so an
  // iOS tab-kill within the grace window never wipes the session.
  const touch = () => {
    try {
      localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  };
  touch();
  setInterval(touch, 60 * 1000);
  window.addEventListener('pagehide', touch);
  document.addEventListener('visibilitychange', touch);
} catch {
  // Ignore storage access failures.
}

export {};
