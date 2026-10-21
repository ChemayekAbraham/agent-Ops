/**
 * Client-side mirror of the placeholder/disposable check, used ONLY to decide
 * whether to nag a user for a working email address.
 *
 * The authority is `supabase/functions/_shared/recipientMailbox.ts`. Nothing
 * here grants anything: if this file drifts, the worst case is that we prompt
 * someone we needn't have, or stay quiet for someone we should have asked.
 * Keep it deliberately simple for that reason — the long disposable list lives
 * server-side and is not worth shipping to the browser.
 */

/** Synthetic addresses minted by phone signup, and closed accounts. */
const PLACEHOLDER_DOMAINS = new Set([
  'welile.user',
  'welile.agent',
  'noapp.welile.user',
  'welile.app',
  'welile.local',
  'welile.test',
  'proxy.welile.local',
  'deleted.invalid',
  'app.local',
  'no-email.local',
  'invalid',
  'localhost',
]);

/** The big providers. ProtonMail counts as a real mailbox. */
const REAL_PROVIDER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'ymail.com',
  'rocketmail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'pm.me', 'mail.com',
  'aol.com', 'gmx.com', 'zoho.com', 'privaterelay.appleid.com',
]);

export function emailDomain(email?: string | null): string {
  if (!email) return '';
  const e = email.trim().toLowerCase();
  return e.includes('@') ? (e.split('@').pop() ?? '') : '';
}

/** True when this address is one of our synthetic placeholders. */
export function isPlaceholderEmail(email?: string | null): boolean {
  const d = emailDomain(email);
  if (!d) return true;
  return [...PLACEHOLDER_DOMAINS].some((p) => d === p || d.endsWith('.' + p));
}

/** True when the address is a mailbox we believe can actually receive mail. */
export function looksDeliverable(email?: string | null): boolean {
  const d = emailDomain(email);
  if (!d || !d.includes('.')) return false;
  if (isPlaceholderEmail(email)) return false;
  if (REAL_PROVIDER_DOMAINS.has(d)) return true;
  // A near-miss on a big provider (gmail.comm, gmal.com) is a typo, not a domain.
  if (/^(gmail|yahoo|outlook|hotmail|icloud|protonmail)\./.test(d)) return false;
  return true;
}

/**
 * Whether this user should still be asked for a working email address. True
 * for our synthetic placeholders, disposable inboxes and obvious typos.
 */
export function needsValidEmail(currentEmail?: string | null): boolean {
  return !looksDeliverable(currentEmail);
}
