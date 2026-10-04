// Shared helpers for two-step verification (2MFA).
//
// A user can only turn 2MFA on when their account has a REAL inbox. Accounts
// created from a phone number get a synthetic placeholder address
// (`<phone>@welile.user`, `<phone>@noapp.welile.user`, `<phone>@welile.app`)
// which can never receive a code, so those are rejected up front.

const SYNTHETIC_DOMAINS = [
  "welile.user",
  "noapp.welile.user",
  "welile.app",
  "welile.local",
  "app.local",
  "no-email.local",
];

/** True when the address cannot receive real mail (synthetic / missing). */
export function isUnusableEmail(email?: string | null): boolean {
  if (!email) return true;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return true;
  const domain = e.split("@").pop() ?? "";
  if (SYNTHETIC_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return true;
  // Phone-derived placeholders on any welile domain (e.g. 256751424629@welile.com)
  const local = e.split("@")[0] ?? "";
  if (/^\+?\d{7,15}$/.test(local) && domain.endsWith("welile.com")) return true;
  return false;
}

/** j***@gmail.com — safe to show in the UI. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "your email";
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, local.length - 1))}@${domain}`;
}

export function generateCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = new DataView(bytes.buffer).getUint32(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

export async function hashCode(userId: string, deviceId: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${userId}:${deviceId}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
