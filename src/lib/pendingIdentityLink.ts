// Small helper for the "link Google after signing in with password" flow.
// When Google sign-in fails because an email/password account already exists,
// we stash the intent here. After the user signs in with their password we
// call supabase.auth.linkIdentity({ provider: 'google' }) automatically.

const KEY = 'welile:pending-identity-link';
const MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

export type PendingIdentityLink = {
  provider: 'google' | 'apple';
  email?: string;
  ts: number;
};

export function setPendingIdentityLink(link: Omit<PendingIdentityLink, 'ts'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...link, ts: Date.now() }));
  } catch { /* ignore */ }
}

export function getPendingIdentityLink(): PendingIdentityLink | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingIdentityLink;
    if (!parsed?.ts || Date.now() - parsed.ts > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingIdentityLink() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Returns true if the given error message from a social sign-in indicates
 * that an account with the same email already exists under another provider.
 * These are the strings Supabase / GoTrue currently returns.
 */
export function isAccountExistsError(message: string | undefined | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('already registered') ||
    m.includes('already exists') ||
    m.includes('user_already_exists') ||
    m.includes('email address is already') ||
    m.includes('identity is already linked') ||
    m.includes('email link is invalid') === false && m.includes('email') && m.includes('taken')
  );
}