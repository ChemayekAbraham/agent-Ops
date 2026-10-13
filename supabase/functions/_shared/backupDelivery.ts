// Delivery rules for database / ledger backup links (PDPO safeguard).
//
// A backup link is a bearer credential for a full copy of personal data, so:
//   * it may only be emailed to a company mailbox (never a personal Gmail), and
//   * it expires after 24 hours, not 7 days.
// Every backup sender and the "resend link" function must go through here.

export const BACKUP_RECIPIENT_DOMAIN = "welile.com";
export const BACKUP_LINK_TTL_SECONDS = 60 * 60 * 24;
export const BACKUP_LINK_TTL_HOURS = BACKUP_LINK_TTL_SECONDS / 3600;

/** Scheduled/default recipients. Change here, not at the call sites. */
export const DEFAULT_BACKUP_RECIPIENTS = ["joshua.wanda@welile.com", "ssenkaali.pius@welile.com"];

export function isCompanyRecipient(email: unknown): email is string {
  if (typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(e) && e.endsWith(`@${BACKUP_RECIPIENT_DOMAIN}`);
}

/** Keeps only company addresses; returns what was dropped so callers can report it. */
export function splitCompanyRecipients(list: unknown[]): { allowed: string[]; rejected: string[] } {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const raw of list) {
    if (isCompanyRecipient(raw)) allowed.push(raw.trim().toLowerCase());
    else rejected.push(String(raw));
  }
  return { allowed: [...new Set(allowed)], rejected };
}
