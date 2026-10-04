/**
 * Durable recruiting-link attribution.
 *
 * Sub-agent invite links (`?ref=<agentId>&become=agent`) used to be stashed in
 * `sessionStorage` by IOSLinkHandler / Join.tsx. sessionStorage dies the moment
 * the browser (or the WhatsApp in-app browser tab) is closed, so a recruit who
 * tapped the link, closed the browser, and came back later signed up with NO
 * parent agent at all. On slow connections the same happened whenever the first
 * page load was abandoned before reaching /auth.
 *
 * This module persists the attribution in BOTH localStorage and a first-party
 * cookie (belt and braces: iOS Safari clears localStorage for some
 * "website data" resets but keeps cookies, and vice-versa), with an explicit
 * 60-day TTL, and captures it from ANY route — not just /auth.
 */

const STORE_KEY = 'welile_referral_attribution';
const COOKIE_KEY = 'welile_ref';
const TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_BECOME = ['agent', 'tenant', 'landlord', 'supporter'];

export interface ReferralAttribution {
  /** Recruiting agent's user id (from `?ref=` / `?r=`). */
  referrerId: string | null;
  /** Role the link is recruiting for (`?become=` / `?role=`). */
  becomeRole: string | null;
  /** Epoch ms of capture. */
  capturedAt: number;
}

function readCookie(): Partial<ReferralAttribution> | null {
  try {
    const raw = document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${COOKIE_KEY}=`))
      ?.slice(COOKIE_KEY.length + 1);
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function writeCookie(value: ReferralAttribution) {
  try {
    const encoded = encodeURIComponent(JSON.stringify(value));
    const maxAge = Math.floor(TTL_MS / 1000);
    document.cookie = `${COOKIE_KEY}=${encoded}; path=/; max-age=${maxAge}; SameSite=Lax`;
  } catch {
    /* cookies blocked — localStorage still covers it */
  }
}

function clearCookie() {
  try {
    document.cookie = `${COOKIE_KEY}=; path=/; max-age=0; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

function readStore(): ReferralAttribution | null {
  let parsed: Partial<ReferralAttribution> | null = null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed) parsed = readCookie();
  if (!parsed) return null;

  const capturedAt = typeof parsed.capturedAt === 'number' ? parsed.capturedAt : 0;
  if (!capturedAt || Date.now() - capturedAt > TTL_MS) return null;

  const referrerId = parsed.referrerId && UUID_RE.test(parsed.referrerId) ? parsed.referrerId.toLowerCase() : null;
  const becomeRole = parsed.becomeRole && VALID_BECOME.includes(parsed.becomeRole) ? parsed.becomeRole : null;
  if (!referrerId && !becomeRole) return null;
  return { referrerId, becomeRole, capturedAt };
}

function persist(value: ReferralAttribution) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    /* private mode — cookie still covers it */
  }
  writeCookie(value);
  // Keep the legacy keys in sync so existing readers (SelectRole, RentRequest*)
  // keep working without changes.
  try {
    if (value.referrerId) localStorage.setItem('referral_agent_id', value.referrerId);
    if (value.becomeRole) localStorage.setItem('become_role', value.becomeRole);
  } catch {
    /* ignore */
  }
}

/**
 * Capture attribution params from a URL (defaults to the current location).
 * Safe to call on every route change — it never downgrades an existing capture.
 */
export function captureReferralAttribution(search?: string): ReferralAttribution | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search ?? window.location.search);
  } catch {
    return readStore();
  }

  const rawRef = (params.get('ref') || params.get('r') || '').trim();
  const rawBecome = (params.get('become') || params.get('role') || '').trim().toLowerCase();

  const referrerId = rawRef && UUID_RE.test(rawRef) ? rawRef.toLowerCase() : null;
  const becomeRole = VALID_BECOME.includes(rawBecome) ? rawBecome : null;

  const existing = readStore();
  if (!referrerId && !becomeRole) {
    // Nothing new in the URL — refresh the persisted copy so a cookie-only or
    // localStorage-only survivor gets written back to both stores.
    if (existing) persist(existing);
    return existing;
  }

  const next: ReferralAttribution = {
    referrerId: referrerId || existing?.referrerId || null,
    becomeRole: becomeRole || existing?.becomeRole || null,
    capturedAt: Date.now(),
  };
  persist(next);
  return next;
}

/** Read the stored attribution, falling back to the legacy localStorage keys. */
export function getReferralAttribution(): ReferralAttribution | null {
  const stored = readStore();
  if (stored) return stored;

  // Legacy fallback: links captured before this module shipped.
  try {
    const legacyRef = localStorage.getItem('referral_agent_id');
    const legacyRole = localStorage.getItem('become_role');
    const referrerId = legacyRef && UUID_RE.test(legacyRef) ? legacyRef.toLowerCase() : null;
    const becomeRole = legacyRole && VALID_BECOME.includes(legacyRole) ? legacyRole : null;
    if (referrerId || becomeRole) return { referrerId, becomeRole, capturedAt: Date.now() };
  } catch {
    /* ignore */
  }
  return null;
}

export function getStoredReferrerId(): string | null {
  return getReferralAttribution()?.referrerId ?? null;
}

export function getStoredBecomeRole(): string | null {
  return getReferralAttribution()?.becomeRole ?? null;
}

/** Called after the parent link has been written server-side. */
export function clearReferralAttribution() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
  clearCookie();
}