import { supabase } from '@/integrations/supabase/client';
import { lovable } from '@/integrations/lovable';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import type { AppRole } from './types';
import { beginOAuthFunnel, trackOAuthRedirected, trackOAuthError, completePendingOAuthFunnel } from '@/lib/oauthFunnel';
import { revokeCurrentDevicePush } from '@/lib/webPush';
import { preflightSignup, attachSignupUser } from '@/lib/signupGuard';
import { getStoredAttributionToken } from '@/lib/campaignAttribution';

// Maintenance lock removed 2026-05-08 — was silently returning a fake
// "Welile is under maintenance" error on every sign-in / sign-up unless
// the URL contained `?admin=c10`, which made password logins and
// admin-reset-password flows appear broken.

export async function signUp(
  email: string,
  password: string,
  fullName: string,
  phone: string,
  role: AppRole,
  signupSource?: string,
  referrerId?: string,
) {
  const guard = await preflightSignup({ email, phone });
  if (!guard.allowed) {
    return { data: null, error: new Error(guard.reason || 'Sign-up is temporarily unavailable from this device or network. Please try again tomorrow.') as Error };
  }
  const redirectUrl = `${window.location.origin}/`;
  // Build metadata explicitly. Only include `signup_source` when it is a
  // non-empty string so the Postgres `handle_new_user` trigger persists it
  // verbatim into `profiles.signup_source` (it NULLIFs empty strings).
  const data: Record<string, unknown> = { full_name: fullName, phone, role };
  const campaignAttributionToken = getStoredAttributionToken();
  if (campaignAttributionToken) data.campaign_attribution_token = campaignAttributionToken;
  const trimmedSource = (signupSource ?? '').trim();
  if (trimmedSource) {
    data.signup_source = trimmedSource;
    // eslint-disable-next-line no-console
    console.log('[signUp] attribution →', { signup_source: trimmedSource, role });
  }
  const trimmedReferrer = (referrerId ?? '').trim();
  // Strict RFC-4122 UUID v1–v8 (lowercase or upper). The DB trigger does a
  // second-layer existence + self-ref + frozen check before accepting it,
  // but we still drop obviously-malformed input client-side so it never
  // reaches the auth metadata in the first place.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (trimmedReferrer && UUID_RE.test(trimmedReferrer)) {
    data.referrer_id = trimmedReferrer.toLowerCase();
    // eslint-disable-next-line no-console
    console.log('[signUp] referrer →', data.referrer_id);
  } else if (trimmedReferrer) {
    // eslint-disable-next-line no-console
    console.warn('[signUp] referrer dropped — not a valid UUID:', trimmedReferrer);
  }
  const { data: signUpData, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl, data },
  });
  if (!error) {
    await attachSignupUser(guard.attempt_id, signUpData?.user?.id ?? null);
  }
  return { data: signUpData, error: error as Error | null };
}

export async function signUpWithoutRole(email: string, password: string, fullName: string, phone: string, referrerId?: string, intendedRole?: string, signupSource?: string) {
  const guard = await preflightSignup({ email, phone });
  if (!guard.allowed) {
    return { data: null, error: new Error(guard.reason || 'Sign-up is temporarily unavailable from this device or network. Please try again tomorrow.') as Error };
  }
  const redirectUrl = `${window.location.origin}/`;
  const data: Record<string, unknown> = {
    full_name: fullName,
    phone,
    referrer_id: referrerId || null,
    intended_role: intendedRole || null,
  };
  const campaignAttributionToken = getStoredAttributionToken();
  if (campaignAttributionToken) data.campaign_attribution_token = campaignAttributionToken;
  // Only include `signup_source` when it is a non-empty string so the Postgres
  // `handle_new_user` trigger persists it verbatim into `profiles.signup_source`
  // (it NULLIFs empty strings). This is what powers connector attribution,
  // e.g. `signup_source=chatgpt` from the public MCP "how Welile works" tool.
  const trimmedSource = (signupSource ?? '').trim();
  if (trimmedSource) {
    data.signup_source = trimmedSource;
    // eslint-disable-next-line no-console
    console.log('[signUpWithoutRole] attribution →', { signup_source: trimmedSource });
  }
  const { data: signUpData, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl, data },
  });
  if (!error) {
    await attachSignupUser(guard.attempt_id, signUpData?.user?.id ?? null);
  }
  return { data: signUpData, error: error as Error | null };
}

export async function signIn(email: string, password: string) {
  try {
    // Pre-auth fraud probe is advisory ONLY and must never gate the spinner.
    // Under database load this PostgREST call has been observed taking many
    // seconds (single-row lookups peaking at ~8s), and because the sign-in
    // flow fires several candidate emails, every slow probe stacked up and
    // left the button stuck on "Signing in...". Hard-cap it and move on —
    // the post-session guard (enforceAccountAccess) still blocks fraud/frozen
    // accounts immediately after authentication.
    const fraudRows = await Promise.race([
      (supabase as any)
        .rpc('check_fraud_account_by_email', { p_email: email.trim().toLowerCase() })
        .then((res: { data: unknown }) => res.data),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
    ]);
    const fraudRow = Array.isArray(fraudRows) ? fraudRows[0] : null;
    if (fraudRow?.is_blocked) {
      return {
        error: new Error('This account has been permanently restricted for fraud review. Access is blocked and the linked phone/email cannot be used again.'),
      };
    }
  } catch {
    // Non-fatal: the session guard still enforces fraud/freeze status after auth.
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: error as Error | null };
}

async function attemptOAuth(provider: 'google' | 'apple', redirectUri: string) {
  console.log(`[OAuth] Attempting ${provider} with redirect_uri:`, redirectUri);
  const result = await lovable.auth.signInWithOAuth(provider, {
    redirect_uri: redirectUri,
  });
  console.log(`[OAuth] ${provider} result:`, { redirected: result.redirected, error: result.error?.message });
  return result;
}

function isPreviewHost(hostname: string) {
  return hostname.includes('id-preview--') || hostname.includes('preview--') || hostname.endsWith('.lovableproject.com');
}

/**
 * Origin to hand the OAuth broker as `redirect_uri`.
 *
 * The broker only accepts redirect URIs that are on the project's auth
 * allow-list (canonical domain + www + Lovable preview hosts). Retired /
 * unregistered legacy hostnames (retired apex domains, which still
 * serves the app) were being passed through verbatim, so the popup opened,
 * the user consented, and the callback was then rejected — 0 successful
 * sign-ins from those hosts. Fall back to the canonical origin instead of
 * silently failing.
 */
function resolveOAuthRedirectOrigin(): string {
  if (typeof window === 'undefined') return getPublicOrigin();
  const { hostname, origin } = window.location;
  const isLocalDev =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local');
  const isAllowListed =
    isLocalDev ||
    isPreviewHost(hostname) ||
    hostname.endsWith('.lovable.app') ||
    origin === getPublicOrigin() ||
    origin === getPublicOrigin().replace('https://', 'https://www.');
  if (isAllowListed) return origin;
  console.warn('[OAuth] Host is not an allow-listed redirect origin — using canonical origin instead:', hostname);
  return getPublicOrigin();
}


async function preparePreviewOAuthFlow() {
  if (!isPreviewHost(window.location.hostname)) return;

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }

    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (error) {
    console.warn('[OAuth] Failed to clear preview service workers/caches:', error);
  }
}

export async function signInWithGoogle() {
  await preparePreviewOAuthFlow();

  // Current origin when it is allow-listed (preview OR canonical custom
  // domain); otherwise the canonical origin, so retired hostnames don't
  // produce a consent screen whose callback is rejected.
  const primaryUri = resolveOAuthRedirectOrigin();

  console.log('[OAuth:Google] domain:', window.location.hostname, '| redirect_uri:', primaryUri);

  const funnelId = await beginOAuthFunnel('google');
  const result = await attemptOAuth('google', primaryUri);
  if (result.redirected) { await trackOAuthRedirected(funnelId, 'google'); return { error: null }; }
  // Preview / popup flow: session set in-place without a full redirect.
  if (!result.error) { await completePendingOAuthFunnel(); return { error: null }; }

  // If provider not supported error, retry with canonical public origin as fallback
  const errMsg = result.error?.message || '';
  if (errMsg.toLowerCase().includes('not supported') || errMsg.toLowerCase().includes('provider')) {
    console.warn('[OAuth:Google] Primary redirect failed, retrying with public origin...');
    const fallbackUri = getPublicOrigin();
    if (fallbackUri !== primaryUri) {
      const retry = await attemptOAuth('google', fallbackUri);
      if (retry.redirected) { await trackOAuthRedirected(funnelId, 'google'); return { error: null }; }
      if (!retry.error) { await completePendingOAuthFunnel(); return { error: null }; }
      await trackOAuthError(funnelId, 'google', retry.error?.message);
      return { error: retry.error ?? null };
    }
  }

  await trackOAuthError(funnelId, 'google', result.error?.message);
  return { error: result.error ?? null };
}

export async function signInWithApple() {
  await preparePreviewOAuthFlow();

  const primaryUri = resolveOAuthRedirectOrigin();

  console.log('[OAuth:Apple] domain:', window.location.hostname, '| redirect_uri:', primaryUri);

  const funnelId = await beginOAuthFunnel('apple');
  const result = await attemptOAuth('apple', primaryUri);
  if (result.redirected) { await trackOAuthRedirected(funnelId, 'apple'); return { error: null }; }
  if (!result.error) { await completePendingOAuthFunnel(); return { error: null }; }

  const errMsg = result.error?.message || '';
  if (errMsg.toLowerCase().includes('not supported') || errMsg.toLowerCase().includes('provider')) {
    console.warn('[OAuth:Apple] Primary redirect failed, retrying with public origin...');
    const fallbackUri = getPublicOrigin();
    if (fallbackUri !== primaryUri) {
      const retry = await attemptOAuth('apple', fallbackUri);
      if (retry.redirected) { await trackOAuthRedirected(funnelId, 'apple'); return { error: null }; }
      if (!retry.error) { await completePendingOAuthFunnel(); return { error: null }; }
      await trackOAuthError(funnelId, 'apple', retry.error?.message);
      return { error: retry.error ?? null };
    }
  }

  await trackOAuthError(funnelId, 'apple', result.error?.message);
  return { error: result.error ?? null };
}

export async function signOutUser(userId: string | undefined) {
  // Activity log insert stubbed for performance
  try { localStorage.removeItem('welile_remember_until'); } catch { /* non-critical */ }
  // Drop "remember this device" markers so OTP is required on next sign-in.
  try {
    localStorage.removeItem('welile_trusted_device');
    localStorage.removeItem('welile_ephemeral_session');
    sessionStorage.removeItem('welile_session_active');
  } catch { /* non-critical */ }
  // Revoke this device's push subscription BEFORE signing out — otherwise RLS
  // blocks the DELETE and the endpoint keeps receiving the prior user's
  // notifications (e.g. merchant-only "New withdrawal to claim" pushes).
  try {
    await revokeCurrentDevicePush(async (endpoint) => {
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    });
  } catch { /* non-critical */ }
  await supabase.auth.signOut();
}

export async function resetPassword(email: string) {
  // Always redirect to the custom domain to avoid Lovable auth-bridge invalidating the token
  const isCustomDomain = !window.location.hostname.includes('lovable.app') && !window.location.hostname.includes('lovableproject.com');
  // On the Lovable preview subdomain, redirect to the custom domain.
  const origin = isCustomDomain ? window.location.origin : 'https://welileapp.com';
  const redirectUrl = `${origin}/update-password`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl });
  return { error: error as Error | null };
}
