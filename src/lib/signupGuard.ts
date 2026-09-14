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
    // Fail-open: never block a real user because our rate-limit RPC threw.
    // Bots hit the trigger + duplicate-account guards downstream.
    // eslint-disable-next-line no-console
    console.warn('[signupGuard] preflight rpc error, allowing:', error.message);
    return { allowed: true, status: 'rpc_error', reason: null, attempt_id: null, is_staff: false };
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