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
//
// The same guard also refuses addresses that cannot receive mail because the
// domain is mistyped (gmal.com, gmail.comm) or fake (gmail.ug.com), or is a
// disposable-inbox service. Supabase warned on 2026-10-20 about a high bounce
// rate; every bounce counts against the project's sending privileges.

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

// Real mailbox providers that sit within a typo's distance of the big ones below.
const REAL_PROVIDER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "pm.me", "mail.com", "aol.com", "gmx.com", "zoho.com",
]);
// Big consumer providers whose near-misses are almost always typos.
const TYPO_TARGETS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "protonmail.com"];
const NEVER_DELIVERABLE_DOMAINS = ["mailinator.com", "gmail.ug.com"];

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1); // swapped neighbours
    }
  }
  return dp[a.length][b.length];
}

/** True when the domain is a mistyped big-provider domain or a known dead/disposable one. */
export function isUndeliverableDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (REAL_PROVIDER_DOMAINS.has(d)) return false;
  if (NEVER_DELIVERABLE_DOMAINS.some((n) => d === n || d.endsWith("." + n))) return true;
  if (/^(gmail|yahoo|outlook|hotmail|icloud|protonmail)./.test(d)) return true; // gmail.<anything> that is not a real provider domain
  return TYPO_TARGETS.some((t) => editDistance(d, t) <= 2);
}

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
  if (isUndeliverableDomain(domain)) return true;
  // Phone-derived placeholders parked on a real welile domain
  // (e.g. 256751424629@welile.com).
  const local = e.split("@")[0] ?? "";
  if (/^\+?\d{7,15}$/.test(local) && domain.endsWith("welile.com")) return true;
  return false;
}
