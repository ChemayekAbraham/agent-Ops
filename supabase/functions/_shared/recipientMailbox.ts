// Central guard for recipient addresses that can never receive real mail.
//
// Accounts created from a phone number alone get a synthetic placeholder
// address (`<phone>@welile.agent`, `<phone>@welile.user`,
// `<phone>@noapp.welile.user`, ...). Closed accounts are rewritten to
// `<something>@deleted.invalid`. None of these are deliverable mailboxes, so
// handing them to the mail provider only produces bounces and damages our
// sending reputation.
//
// Every send path must pass through `isPlaceholderRecipient` before transport.
// Phone-only users keep receiving SMS and in-app notifications as before.

const PLACEHOLDER_DOMAINS = [
  "welile.user",
  "welile.agent",
  "noapp.welile.user",
  "welile.app",
  "welile.local",
  "welile.test",
  "proxy.welile.local",
  "deleted.invalid",
  "app.local",
  "no-email.local",
  "invalid",
  "localhost",
];

export const PLACEHOLDER_SUPPRESSION_REASON = "placeholder_recipient";

/** True when the address is synthetic/internal and must never be mailed. */
export function isPlaceholderRecipient(email?: string | null): boolean {
  if (!email) return true;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return true;
  const domain = e.split("@").pop() ?? "";
  if (!domain.includes(".") && domain !== "localhost") return true;
  if (PLACEHOLDER_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) {
    return true;
  }
  // Phone-derived placeholders parked on a real welile domain
  // (e.g. 256751424629@welile.com).
  const local = e.split("@")[0] ?? "";
  if (/^\+?\d{7,15}$/.test(local) && domain.endsWith("welile.com")) return true;
  return false;
}
