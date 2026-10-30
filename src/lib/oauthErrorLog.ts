// Persistent OAuth error log — captures the exact failure reason with
// timestamp so users (and support) can see WHY a Google/Apple sign-in
// failed, not just a generic toast that disappears.

import { setPendingIdentityLink } from '@/lib/pendingIdentityLink';

const KEY = 'welile_oauth_error_v1';

export type OAuthErrorRecord = {
  provider: 'google' | 'apple' | string;
  message: string;
  code?: string;
  context?: string; // e.g. 'signInWithOAuth', 'redirect_callback'
  at: string; // ISO timestamp
  url?: string;
  userAgent?: string;
};

export function recordOAuthError(input: Omit<OAuthErrorRecord, 'at' | 'url' | 'userAgent'>) {
  try {
    const rec: OAuthErrorRecord = {
      ...input,
      at: new Date().toISOString(),
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    };
    localStorage.setItem(KEY, JSON.stringify(rec));
    window.dispatchEvent(new CustomEvent('welile:oauth-error', { detail: rec }));
    return rec;
  } catch {
    return null;
  }
}

export function readOAuthError(): OAuthErrorRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OAuthErrorRecord;
  } catch {
    return null;
  }
}

export function clearOAuthError() {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent('welile:oauth-error', { detail: null }));
  } catch { /* ignore */ }
}

// Parse ?error=&error_description= (query or hash) that OAuth providers
// append when they redirect back after a failure. Returns null if none.
export function captureOAuthRedirectError(provider: string = 'google'): OAuthErrorRecord | null {
  if (typeof window === 'undefined') return null;
  const parse = (s: string) => new URLSearchParams(s.startsWith('#') || s.startsWith('?') ? s.slice(1) : s);
  const q = parse(window.location.search);
  const h = parse(window.location.hash);
  const err = q.get('error') || h.get('error');
  if (!err) return null;
  const desc = q.get('error_description') || h.get('error_description') || '';
  const code = q.get('error_code') || h.get('error_code') || undefined;
  const raw = decodeURIComponent(desc || err);
  // The database refused to open a new account for this Google/Apple sign-in. The
  // usual reason is that the email is already on an account that signs in by phone
  // (trigger block_oauth_duplicate_signup); the device signup cap and fraud blocks
  // surface the same way. Supabase hides the reason, so guide the person to their
  // existing account and link the provider once they are in.
  if (/database error saving new user/i.test(raw) && (provider === 'google' || provider === 'apple')) {
    setPendingIdentityLink({ provider });
    return recordOAuthError({
      provider,
      message: `${provider === 'google' ? 'Google' : 'Apple'} could not open a new account. If you already have a Welile account, sign in below with your phone number and password and we will connect ${provider === 'google' ? 'Google' : 'Apple'} to it automatically.`,
      code: code || err,
      context: 'redirect_callback',
    });
  }
  return recordOAuthError({
    provider,
    message: raw,
    code: code || err,
    context: 'redirect_callback',
  });
}