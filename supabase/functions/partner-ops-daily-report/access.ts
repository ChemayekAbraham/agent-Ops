// Who may call partner-ops-daily-report, and with which options.
//
// The function is deployed with verify_jwt = false and was open to anyone: `preview`, `pdf` and `to`
// returned or mailed the whole partner book. Now:
//   full - the service-role key, the optional REPORT_SECRET header, or a signed-in partner-staff user
//          (PARTNER_STAFF_ROLES, enabled role): every option, as before;
//   cron - no credentials, or the public anon key (today's cron sends only the apikey header and
//          { date: <today EAT> }): ONLY today's default daily send to the fixed recipients, which the
//          existing send log makes idempotent;
//   deny - a user token that does not verify (401), a signed-in user who is not partner staff (403), or
//          partner staff whose session lacks the two-step sign-in staff_mfa_ok() would require (403).
import { PARTNER_STAFF_ROLES } from "../_shared/partnerReturnPolicy.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type ReportAccess =
  | { mode: "full" }
  | { mode: "cron" }
  | { mode: "deny"; status: 401 | 403; error?: string };

export const CRON_OPTIONS_DENIED = "Sign in as partner staff to use report options.";
export const NOT_PARTNER_STAFF = "Partner staff only.";
export const STAFF_MFA_REQUIRED = "Staff two-step sign-in required";
export const STAFF_MFA_UNCHECKED = "Could not check staff two-step sign-in. Please try again.";

/**
 * The role lists of public.staff_mfa_ok() as read from production (pg_get_functiondef, 2026-11-07):
 * mode 'all' asks aal2 of anyone holding an enabled role in the first list, mode 'admin' of anyone in the
 * second; any other mode (or no config row) asks nothing. Keep in step with that function.
 */
export const STAFF_MFA_ALL_ROLES = [
  "manager", "super_admin", "coo", "ceo", "cto", "cfo", "cmo", "crm", "hr", "rd", "operations", "employee",
  "tenant_ops", "agent_ops", "landlord_ops", "partner_ops", "financial_ops", "access_admin", "admin",
] as const;
export const STAFF_MFA_ADMIN_ROLES = ["super_admin", "ceo", "cto", "cfo", "coo", "access_admin", "admin"] as const;

/** The claims of a JWT WITHOUT verifying it. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** The `role` claim of a JWT WITHOUT verifying it (only used to decide whether to verify it). */
export function unverifiedJwtRole(token: string): string | null {
  const role = jwtClaims(token)?.role;
  return typeof role === "string" ? role : null;
}

/** The `aal` claim of a token, read only AFTER the auth server verified it; missing counts as aal1. */
function tokenAal(token: string): string {
  const aal = jwtClaims(token)?.aal;
  return typeof aal === "string" ? aal : "aal1";
}

/** Does the caller hold an enabled role from `list`? Throws on a read error (the caller fails closed). */
async function holdsEnabledRole(admin: Client, userId: string, list: readonly string[]): Promise<boolean> {
  const { data, error } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("enabled", true)
    .in("role", [...list])
    .limit(1);
  if (error) throw new Error(error.message ?? "user_roles read failed");
  return Array.isArray(data) && data.length > 0;
}

/**
 * The same decision as public.staff_mfa_ok() for a verified user token: null when the session may go
 * on, else the deny. An aal2 session needs no reads. A failed read denies (fail closed); a missing
 * config row allows, as staff_mfa_ok() does.
 */
async function staffMfaDeny(admin: Client, userId: string, token: string): Promise<ReportAccess | null> {
  if (tokenAal(token) === "aal2") return null;
  try {
    const { data, error } = await admin.from("staff_mfa_config").select("mode").eq("id", true).maybeSingle();
    if (error) return { mode: "deny", status: 403, error: STAFF_MFA_UNCHECKED };
    const mode = typeof data?.mode === "string" ? data.mode : null;
    const list = mode === "all" ? STAFF_MFA_ALL_ROLES : mode === "admin" ? STAFF_MFA_ADMIN_ROLES : null;
    if (!list) return null;
    return (await holdsEnabledRole(admin, userId, list))
      ? { mode: "deny", status: 403, error: STAFF_MFA_REQUIRED }
      : null;
  } catch {
    return { mode: "deny", status: 403, error: STAFF_MFA_UNCHECKED };
  }
}

/** Constant-time string equality for secrets (length still leaks, which is fine for fixed-size keys). */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function reportAccess(
  req: Request,
  admin: Client,
  env: { serviceKey: string; reportSecret?: string },
): Promise<ReportAccess> {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const secretHeader = req.headers.get("x-report-secret") ?? "";
  if (env.reportSecret && sameSecret(secretHeader, env.reportSecret)) return { mode: "full" };
  if (bearer && sameSecret(bearer, env.serviceKey)) return { mode: "full" };
  if (bearer && unverifiedJwtRole(bearer) === "authenticated") {
    // A user token: verified against the auth server, then the caller's enabled roles, then the staff
    // two-step rule (staff_mfa_ok) on the verified token's aal.
    let userId: string;
    try {
      const { data, error } = await admin.auth.getUser(bearer);
      if (error || !data?.user?.id) return { mode: "deny", status: 401 };
      userId = data.user.id;
    } catch {
      return { mode: "deny", status: 401 };
    }
    try {
      if (!(await holdsEnabledRole(admin, userId, PARTNER_STAFF_ROLES))) return { mode: "deny", status: 403 };
    } catch {
      return { mode: "deny", status: 403 };
    }
    return (await staffMfaDeny(admin, userId, bearer)) ?? { mode: "full" };
  }
  return { mode: "cron" }; // no credentials, or the anon apikey (today's cron)
}

/** Body keys only a full-access caller may send. */
const FULL_ONLY_KEYS = ["preview", "pdf", "to", "force", "start", "end"] as const;

/**
 * A cron-mode request may only ask for today's default daily send: none of the option keys, `date`
 * absent or today's EAT date (what the cron sends), `period` absent or 'daily'.
 */
export function cronBodyAllowed(body: Record<string, unknown> | null | undefined, todayEat: string): boolean {
  const b = body ?? {};
  for (const k of FULL_ONLY_KEYS) if (b[k] !== undefined) return false;
  if (b.date !== undefined && !(typeof b.date === "string" && b.date.slice(0, 10) === todayEat)) return false;
  if (b.period !== undefined && b.period !== "daily") return false;
  return true;
}

/**
 * The JSON a send answers with. Full access: the whole send result, as before. Cron mode (no staff
 * credentials, so possibly anyone): only that it ran and whether it skipped. Never the recipients,
 * per-recipient results or the book's figures.
 */
export function sendResponseBody(mode: "full" | "cron", report: object | null | undefined): Record<string, unknown> {
  if (mode === "full") return { success: true, report };
  return { success: true, skipped: (report as { skipped?: unknown } | null | undefined)?.skipped === true };
}
