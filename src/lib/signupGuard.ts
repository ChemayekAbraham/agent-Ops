import { supabase } from '@/integrations/supabase/client';
import { getDeviceFingerprint, isValidFingerprintShape } from './deviceFingerprint';

export type SignupGuardResult = {
  allowed: boolean;
  status: string;
  reason: string | null;
  attempt_id: string | null;
  is_staff: boolean;
};

function readUtm() {
  try {
    const q = new URLSearchParams(window.location.search);
    return {
      utm_source: q.get('utm_source') || null,
      utm_medium: q.get('utm_medium') || null,
      utm_campaign: q.get('utm_campaign') || null,
      referrer: (document.referrer || '').slice(0, 500) || null,
    };
  } catch {
    return { utm_source: null, utm_medium: null, utm_campaign: null, referrer: null };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Client-side burst / bot defences (layered on top of server-side RPC guard)
// ────────────────────────────────────────────────────────────────────────────
const BURST_KEY = 'welile_signup_burst';
const BURST_MAX = 3;          // max signups per window
const BURST_WINDOW_MS = 3600_000; // 1 hour
const COOLDOWN_KEY = 'welile_signup_cooldown';
const COOLDOWN_MS = 15_000;   // 15 s between attempts

/** Record a signup attempt timestamp. Returns true if burst limit exceeded. */
function isBurstLimited(): boolean {
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(BURST_KEY);
    const stamps: number[] = raw ? JSON.parse(raw) : [];
    const recent = stamps.filter(t => now - t < BURST_WINDOW_MS);
    if (recent.length >= BURST_MAX) return true;
    recent.push(now);
    sessionStorage.setItem(BURST_KEY, JSON.stringify(recent));
    return false;
  } catch { return false; }
}

/** Returns true if the last signup was less than COOLDOWN_MS ago. */
function isCooldownActive(): boolean {
  try {
    const last = Number(sessionStorage.getItem(COOLDOWN_KEY) || '0');
    if (Date.now() - last < COOLDOWN_MS) return true;
    sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
    return false;
  } catch { return false; }
}

/**
 * Runs the server-side pre-signup rate-limit + logging check. Call this
 * IMMEDIATELY before `supabase.auth.signUp(...)` (or any equivalent account
 * creation edge function). If `allowed` is false, abort the signup and show
 * `reason` to the user.
 *
 * Staff-assisted signups (agent, manager, ceo/coo/cto/cmo, *_ops, super_admin,
 * hr, employee, crm, admin) are exempt from the cap server-side.
 */
export async function preflightSignup(params: {
  email?: string | null;
  phone?: string | null;
  path?: string | null;
}): Promise<SignupGuardResult> {
  // ── Layer 1: client-side burst + cooldown guard ───────────────────────
  if (isCooldownActive()) {
    return {
      allowed: false,
      status: 'cooldown',
      reason: 'Please wait a few seconds before trying again.',
      attempt_id: null,
      is_staff: false,
    };
  }
  if (isBurstLimited()) {
    return {
      allowed: false,
      status: 'burst_limited',
      reason: 'Too many sign-up attempts. Please try again in an hour.',
      attempt_id: null,
      is_staff: false,
    };
  }

  // ── Layer 2: server-side RPC guard ────────────────────────────────────
  const rawFp = await getDeviceFingerprint().catch(() => null);
  // Never send a tampered / malformed fingerprint to the server. If the
  // client-side value fails shape validation we drop it — the server will
  // then treat the attempt as `bad_fingerprint` and refuse the signup.
  const deviceFp = isValidFingerprintShape(rawFp) ? rawFp : null;
  const utm = readUtm();
  const path = (params.path || (typeof window !== 'undefined' ? window.location.pathname : '/')) || '/';
  const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 500) : null;

  const { data, error } = await (supabase as any).rpc('record_signup_attempt', {
    p_device_fp: deviceFp,
    p_path: path,
    p_utm_source: utm.utm_source,
    p_utm_medium: utm.utm_medium,
    p_utm_campaign: utm.utm_campaign,
    p_referrer: utm.referrer,
    p_user_agent: ua,
    p_email: params.email ?? null,
    p_phone: params.phone ?? null,
  });
  if (error) {
    // Fail-CLOSED: block the signup when the guard RPC fails.
    // Previously fail-open, but bots exploit RPC timeouts to bypass the guard.
    // Real users will see a transient error and can retry after the cooldown.
    // eslint-disable-next-line no-console
    console.warn('[signupGuard] preflight rpc error, BLOCKING:', error.message);
    return {
      allowed: false,
      status: 'rpc_error',
      reason: 'Sign-up is temporarily unavailable. Please try again in a moment.',
      attempt_id: null,
      is_staff: false,
    };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    allowed: Boolean(row.allowed),
    status: String(row.status ?? 'unknown'),
    reason: (row.reason as string | null) ?? null,
    attempt_id: (row.attempt_id as string | null) ?? null,
    is_staff: Boolean(row.is_staff),
  };
}

/**
 * After a successful signUp, link the attempt row to the created user so the
 * CTO signup source log can show a real "successful signup" count per path.
 */
export async function attachSignupUser(attemptId: string | null, userId: string | null | undefined) {
  if (!attemptId || !userId) return;
  try {
    await (supabase as any).rpc('attach_signup_attempt_user', {
      p_attempt_id: attemptId,
      p_user_id: userId,
    });
  } catch { /* non-critical */ }
}