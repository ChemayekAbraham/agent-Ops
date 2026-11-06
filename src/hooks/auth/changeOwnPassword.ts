import type { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

/**
 * Signed-in password change (Settings → Account → Password). Logic only; the form is UI.
 *
 * The old handler re-checked the current password with `profiles.email`. That column is the
 * display email, not the login: phone sign-ups keep a synthetic `…@welile.user` /
 * `…@welile.agent` auth email while the profile carries their Gmail, and an email change
 * updates the profile before the auth email is confirmed. For those people the re-check
 * always failed, and every failure (wrong identifier, rate limit, timeout, Google-only
 * account) was reported as "Current password is incorrect". The login form resolves the
 * real auth email for the same reason (useAuthForm, get_email_by_phone v2).
 *
 * Here the identifier comes from the session itself (auth.users.email, or phone for a
 * phone-only account), and each failure gets its own message.
 *
 * The re-check stays on the main client on purpose: the session that calls updateUser is the
 * one the browser keeps (a password change can end the user's other sessions), and the fresh
 * sign-in also satisfies Supabase's "secure password change" recent-login rule.
 */

export const MIN_PASSWORD_LENGTH = 6;

export type ChangePasswordResult =
  // `message?` on the ok branch lets callers read it after `!result.ok` without strictNullChecks.
  | { ok: true; reason?: undefined; message?: undefined }
  | { ok: false; reason: ChangePasswordFailure; message: string };

export type ChangePasswordFailure =
  | 'too_short'
  | 'mismatch'
  | 'same_password'
  | 'no_session'
  | 'no_password_login'
  | 'wrong_current_password'
  | 'rate_limited'
  | 'network'
  | 'weak_password'
  | 'update_failed';

const MESSAGES: Record<ChangePasswordFailure, string> = {
  too_short: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  mismatch: "Passwords don't match",
  same_password: 'New password must be different from your current password',
  no_session: 'Your session has expired. Please sign in again, then change your password.',
  no_password_login:
    'That password did not match. Your account signs in with Google or Apple and may not have a password yet: use "Forgot Password?" on the sign-in screen to create one.',
  wrong_current_password:
    'Current password is incorrect. If you have forgotten it, sign out and use "Forgot Password?" to reset it by SMS.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  network: 'Could not reach the server. Check your connection and try again.',
  weak_password: 'That password is too weak. Choose a longer one that is harder to guess.',
  update_failed: 'Could not update your password. Please try again.',
};

function fail(reason: ChangePasswordFailure, message = MESSAGES[reason]): ChangePasswordResult {
  return { ok: false, reason, message };
}

interface AuthLikeError {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
}

/** Maps a supabase-js auth error to a failure reason. Exported for tests. */
export function classifyAuthError(err: AuthLikeError | null | undefined, stage: 'verify' | 'update'): ChangePasswordFailure {
  const code = err?.code ?? '';
  const msg = (err?.message ?? '').toLowerCase();
  const status = err?.status ?? 0;
  if (code === 'same_password' || msg.includes('should be different')) return 'same_password';
  if (code === 'weak_password' || msg.includes('weak')) return 'weak_password';
  if (status === 429 || code.startsWith('over_') || msg.includes('rate limit') || msg.includes('too many')) return 'rate_limited';
  if (
    err?.name === 'AuthRetryableFetchError' ||
    (status === 0 && (msg.includes('fetch') || msg.includes('network') || msg.includes('abort') || msg.includes('load failed'))) ||
    status >= 500 ||
    msg.includes('timeout')
  ) {
    return 'network';
  }
  if (stage === 'verify' && (code === 'invalid_credentials' || msg.includes('invalid login credentials'))) {
    return 'wrong_current_password';
  }
  if (code === 'session_not_found' || code === 'bad_jwt' || msg.includes('auth session missing')) return 'no_session';
  return stage === 'verify' ? 'wrong_current_password' : 'update_failed';
}

/** True when the account has only OAuth identities, so it has never had a password. */
export function isOAuthOnly(user: Pick<User, 'identities' | 'app_metadata'>): boolean {
  const providers = new Set<string>();
  for (const identity of user.identities ?? []) providers.add(identity.provider);
  for (const p of (user.app_metadata?.providers as string[] | undefined) ?? []) providers.add(p);
  if (!providers.size) return false;
  return !providers.has('email') && !providers.has('phone');
}

export async function changeOwnPassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<ChangePasswordResult> {
  const { currentPassword, newPassword, confirmPassword } = input;
  if (newPassword.length < MIN_PASSWORD_LENGTH) return fail('too_short');
  if (newPassword !== confirmPassword) return fail('mismatch');
  if (newPassword === currentPassword) return fail('same_password');

  // The live session's user is the login identity; the profile row is not.
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return fail('no_session');

  const email = user.email?.trim();
  const phone = user.phone?.trim();
  if (!email && !phone) return fail('no_password_login');

  try {
    const { data: signInData, error: signInError } = email
      ? await supabase.auth.signInWithPassword({ email, password: currentPassword })
      : await supabase.auth.signInWithPassword({ phone: phone!, password: currentPassword });
    if (signInError) {
      const reason = classifyAuthError(signInError, 'verify');
      // A Google/Apple-only account usually has no password at all; ~130 do, set by a later
      // reset, so this only explains a failed re-check instead of blocking it up front.
      if (reason === 'wrong_current_password' && isOAuthOnly(user)) return fail('no_password_login');
      return fail(reason);
    }
    // Never let the re-check land on a different account.
    if (signInData.user && signInData.user.id !== user.id) return fail('wrong_current_password');

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) {
      const reason = classifyAuthError(updateError, 'update');
      return fail(reason, reason === 'update_failed' && updateError.message ? `Could not update your password: ${updateError.message}` : MESSAGES[reason]);
    }
  } catch (e) {
    return fail(classifyAuthError(e as AuthLikeError, 'update'));
  }

  supabase.functions.invoke('record-password-change').catch(() => {});
  return { ok: true };
}
