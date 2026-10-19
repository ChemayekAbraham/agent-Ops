// Persistent session cache for instant auth state on app load
// Uses localStorage for persistence across browser restarts
// Cache is refreshed in background without affecting user activity

// supabase-js stores the session under `sb-<project-ref>-auth-token`; the ref comes from the configured URL so the key
// follows the project (the previous project's key is cleared too, for browsers that still hold it).
const SUPABASE_PROJECT_REF = (() => {
  try { return new URL(String(import.meta.env.VITE_SUPABASE_URL)).hostname.split('.')[0]; } catch { return ''; }
})();
const AUTH_TOKEN_KEYS = [SUPABASE_PROJECT_REF && `sb-${SUPABASE_PROJECT_REF}-auth-token`, 'sb-wirntoujqoyjobfhyelc-auth-token'].filter(Boolean) as string[];

const SESSION_CACHE_KEY = 'welile_session_cache';
const ROLES_CACHE_KEY = 'welile_roles_cache';

// Session cache TTL: 7 days — Supabase refresh tokens handle actual auth validity
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
// Roles can be cached even longer since they rarely change
const ROLES_CACHE_TTL = 14 * 24 * 60 * 60 * 1000;

// Background refresh threshold: refresh cache silently after 30 min
const BACKGROUND_REFRESH_THRESHOLD = 30 * 60 * 1000;

interface CachedSession {
  userId: string;
  email: string;
  expiresAt: number;
  cachedAt: number;
}

interface CachedRoles {
  roles: string[];
  cachedAt: number;
}

export function getCachedSession(): CachedSession | null {
  try {
    // Try localStorage first (persistent), fall back to sessionStorage (migration)
    let cached = localStorage.getItem(SESSION_CACHE_KEY);
    if (!cached) {
      cached = sessionStorage.getItem(SESSION_CACHE_KEY);
      if (cached) {
        // Migrate from sessionStorage to localStorage
        localStorage.setItem(SESSION_CACHE_KEY, cached);
        sessionStorage.removeItem(SESSION_CACHE_KEY);
      }
    }
    if (!cached) return null;

    const parsed: CachedSession = JSON.parse(cached);
    const now = Date.now();

    // Only expire if cache is very old (7 days)
    if (now - parsed.cachedAt > CACHE_TTL) {
      localStorage.removeItem(SESSION_CACHE_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Check if session cache should be refreshed in background (stale but still valid) */
export function isSessionCacheStale(): boolean {
  try {
    const cached = localStorage.getItem(SESSION_CACHE_KEY);
    if (!cached) return true;
    const parsed: CachedSession = JSON.parse(cached);
    return (Date.now() - parsed.cachedAt) > BACKGROUND_REFRESH_THRESHOLD;
  } catch {
    return true;
  }
}

export function setCachedSession(userId: string, email: string, expiresAt: number): void {
  try {
    const cache: CachedSession = {
      userId,
      email,
      expiresAt,
      cachedAt: Date.now(),
    };
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache));
    // Clean up legacy sessionStorage entry
    sessionStorage.removeItem(SESSION_CACHE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function clearSessionCache(): void {
  try {
    localStorage.removeItem(SESSION_CACHE_KEY);
    localStorage.removeItem(ROLES_CACHE_KEY);
    // Also clear legacy sessionStorage entries
    sessionStorage.removeItem(SESSION_CACHE_KEY);
    sessionStorage.removeItem(ROLES_CACHE_KEY);
  } catch {
    // Ignore
  }
}

/**
 * Clear ALL auth-related storage (tokens, caches) to eliminate stale refresh tokens.
 * Use ONLY on explicit sign-out or definitive auth errors — never on tab close.
 */
export function clearAllAuthStorage(): void {
  try {
    AUTH_TOKEN_KEYS.forEach((k) => localStorage.removeItem(k));
    localStorage.removeItem(SESSION_CACHE_KEY);
    localStorage.removeItem(ROLES_CACHE_KEY);
    sessionStorage.removeItem(SESSION_CACHE_KEY);
    sessionStorage.removeItem(ROLES_CACHE_KEY);
    sessionStorage.removeItem('welile_session_only');
  } catch {
    // Ignore storage errors
  }
}

/** A signed-in session lasts at most this long from sign-in; then the person signs in again. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function decodeJwtPayload(token: string | undefined | null): Record<string, any> | null {
  if (!token) return null;
  try {
    let part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (part.length % 4) part += '=';
    return JSON.parse(atob(part));
  } catch {
    return null;
  }
}

/**
 * When this session was signed in, in ms. Read from the access token's `amr`
 * timestamps (set at sign-in and carried unchanged through every refresh, so it
 * is per-session, not per-account), falling back to the user's last_sign_in_at.
 */
export function sessionSignedInAtMs(
  session: { access_token?: string; user?: { last_sign_in_at?: string | null } } | null | undefined,
): number | null {
  if (!session) return null;
  const amr = decodeJwtPayload(session.access_token)?.amr;
  if (Array.isArray(amr)) {
    const stamps = amr.map((a: any) => Number(a?.timestamp)).filter((t) => Number.isFinite(t) && t > 0);
    if (stamps.length) return Math.min(...stamps) * 1000;
  }
  const last = session.user?.last_sign_in_at ? Date.parse(session.user.last_sign_in_at) : NaN;
  return Number.isFinite(last) ? last : null;
}

/** True once a session is older than SESSION_MAX_AGE_MS. Unknown age never counts as expired. */
export function isSessionPastMaxAge(
  session: { access_token?: string; user?: { last_sign_in_at?: string | null } } | null | undefined,
): boolean {
  const signedInAt = sessionSignedInAtMs(session);
  return signedInAt !== null && Date.now() - signedInAt > SESSION_MAX_AGE_MS;
}

/**
 * The session supabase-js has persisted for the current project, read straight
 * from localStorage without taking the auth lock. Used only to keep a signed-in
 * person on their dashboard while a slow token refresh finishes; it is never
 * trusted for anything the server does not re-check.
 */
export function readStoredAuthSession(): { access_token: string; refresh_token: string; expires_at?: number; user: any } | null {
  const key = AUTH_TOKEN_KEYS[0];
  if (!key || !SUPABASE_PROJECT_REF) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (parsed?.access_token && parsed?.refresh_token && parsed?.user?.id) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

// Default role for all users - agent is always available offline
const DEFAULT_OFFLINE_ROLES: string[] = ['agent'];

export function getCachedRoles(): string[] | null {
  try {
    // Try localStorage first, fall back to sessionStorage (migration)
    let cached = localStorage.getItem(ROLES_CACHE_KEY);
    if (!cached) {
      cached = sessionStorage.getItem(ROLES_CACHE_KEY);
      if (cached) {
        localStorage.setItem(ROLES_CACHE_KEY, cached);
        sessionStorage.removeItem(ROLES_CACHE_KEY);
      }
    }
    if (!cached) return DEFAULT_OFFLINE_ROLES;

    const parsed: CachedRoles = JSON.parse(cached);
    const now = Date.now();

    if (now - parsed.cachedAt > ROLES_CACHE_TTL) {
      localStorage.removeItem(ROLES_CACHE_KEY);
      return DEFAULT_OFFLINE_ROLES;
    }

    if (!parsed.roles.includes('agent')) {
      return ['agent', ...parsed.roles];
    }

    return parsed.roles;
  } catch {
    return DEFAULT_OFFLINE_ROLES;
  }
}

export function setCachedRoles(roles: string[]): void {
  try {
    const cache: CachedRoles = {
      roles,
      cachedAt: Date.now(),
    };
    localStorage.setItem(ROLES_CACHE_KEY, JSON.stringify(cache));
    sessionStorage.removeItem(ROLES_CACHE_KEY);
  } catch {
    // Ignore storage errors
  }
}

// Preload session on module load (runs immediately when imported)
let preloadedSession: CachedSession | null = null;
let preloadedRoles: string[] | null = null;

try {
  preloadedSession = getCachedSession();
  preloadedRoles = getCachedRoles();
} catch {
  preloadedRoles = DEFAULT_OFFLINE_ROLES;
}

if (!preloadedRoles || preloadedRoles.length === 0) {
  preloadedRoles = DEFAULT_OFFLINE_ROLES;
}

export function getPreloadedSession(): CachedSession | null {
  return preloadedSession;
}

export function getPreloadedRoles(): string[] | null {
  return preloadedRoles && preloadedRoles.length > 0 ? preloadedRoles : DEFAULT_OFFLINE_ROLES;
}
