/**
 * Where to send someone after they sign in: the page they were on when they signed out or their session ended,
 * instead of the default dashboard.
 *
 * While a person is signed in, the page they are on is remembered against their user id. After sign-in, the same
 * person is sent back there; a different person signing in on the same device never inherits it. Only in-app paths
 * are ever used, so a crafted ?redirect= can't send anyone to another site.
 */

const RETURN_PATH_KEY = 'welile_return_path';
/** Matches the 7-day session limit: an older page is not a "previous page" any more. */
const RETURN_PATH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Pages that are never worth returning to: sign-in, onboarding, and the public landing pages. */
const NOT_A_RETURN_PAGE = [
  /^\/$/,
  /^\/auth(\/|$)/,
  /^\/welcome(\/|$)/,
  /^\/campaign(\/|$)/,
  /^\/select-role(\/|$)/,
  /^\/update-password(\/|$)/,
  /^\/oauth/i,
  /^\/install(\/|$)/,
  /^\/join(\/|$)/,
  /^\/r\//,
];

/** An in-app path ("/x"), never another origin ("//evil.com", "/\evil.com", "https://…"). */
export function safeInternalPath(path: string | null | undefined): string | null {
  if (!path || typeof path !== 'string') return null;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return null;
  return path;
}

export function isReturnablePath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0];
  return !NOT_A_RETURN_PAGE.some((re) => re.test(pathname));
}

/** Remember the page a signed-in person is on. */
export function rememberReturnPath(userId: string, path: string): void {
  const safe = safeInternalPath(path);
  if (!userId || !safe || !isReturnablePath(safe)) return;
  try {
    localStorage.setItem(RETURN_PATH_KEY, JSON.stringify({ userId, path: safe, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

/** The page this person was last on, if any — consumed, so it applies to one sign-in only. */
export function takeReturnPath(userId: string): string | null {
  try {
    const raw = localStorage.getItem(RETURN_PATH_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.userId !== userId) return null; // someone else's page: leave it for them
    localStorage.removeItem(RETURN_PATH_KEY);
    if (Date.now() - Number(saved.at || 0) > RETURN_PATH_MAX_AGE_MS) return null;
    const safe = safeInternalPath(saved.path);
    return safe && isReturnablePath(safe) ? safe : null;
  } catch {
    return null;
  }
}

/**
 * Where to go once signed in: an explicit ?redirect= first, then the page this person was last on, else the
 * dashboard resolver.
 */
export function postSignInPath(userId: string, redirectParam: string | null | undefined): string {
  const fromParam = safeInternalPath(redirectParam);
  if (fromParam && isReturnablePath(fromParam)) {
    takeReturnPath(userId); // consumed either way, so it can't resurface on a later sign-in
    return fromParam;
  }
  return takeReturnPath(userId) ?? '/dashboard';
}
