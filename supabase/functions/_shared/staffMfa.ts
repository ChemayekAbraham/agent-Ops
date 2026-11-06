// Staff two-step verification policy (PDPO safeguard).
//
// Any account holding a role outside the public-facing set below is "staff" and
// must verify each new device with an emailed code, whether or not they ever
// switched 2MFA on themselves. Kill switch: set secret STAFF_MFA_ENFORCE=false.

export const NON_STAFF_ROLES = ["agent", "tenant", "landlord", "supporter"];

export function staffMfaEnforced(): boolean {
  return (Deno.env.get("STAFF_MFA_ENFORCE") ?? "true").toLowerCase() !== "false";
}

export function hasStaffRole(roles: string[]): boolean {
  return roles.some((r) => !NON_STAFF_ROLES.includes(r));
}

// deno-lint-ignore no-explicit-any
export async function isStaffUser(admin: any, userId: string): Promise<boolean> {
  if (!staffMfaEnforced()) return false;
  const { data } = await admin.from("user_roles").select("role").eq("user_id", userId);
  return hasStaffRole((data ?? []).map((r: { role: string }) => String(r.role)));
}

// ---------------------------------------------------------------------------
// Authenticator-app (TOTP) enforcement, doc 249 / docs/security/mfa-enforcement-design.md.
// The database side is the restrictive policy `mfa_required_for_staff` on every table, driven by
// public.staff_mfa_config.mode. Edge functions that use the SERVICE key bypass those policies, so
// money-moving and admin functions must call requireStaffAal2() themselves.
// ---------------------------------------------------------------------------

export const GATED_STAFF_ROLES = [
  "manager", "super_admin", "coo", "ceo", "cto", "cfo", "cmo", "crm", "hr", "rd", "operations",
  "employee", "tenant_ops", "agent_ops", "landlord_ops", "partner_ops", "financial_ops",
  "access_admin", "admin",
];
export const ADMIN_ROLES = ["super_admin", "ceo", "cto", "cfo", "coo", "access_admin", "admin"];

/** Assurance level ("aal1" password only, "aal2" password + authenticator) of an access token the caller has ALREADY verified with auth.getUser(). */
export function aalFromToken(token: string): string {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(payload)).aal ?? "aal1");
  } catch {
    return "aal1";
  }
}

export type StaffMfaMode = "off" | "shadow" | "admin" | "all";

// deno-lint-ignore no-explicit-any
export async function staffMfaMode(admin: any): Promise<StaffMfaMode> {
  const { data } = await admin.from("staff_mfa_config").select("mode").eq("id", true).maybeSingle();
  const m = String(data?.mode ?? "shadow");
  return (["off", "shadow", "admin", "all"].includes(m) ? m : "shadow") as StaffMfaMode;
}

/**
 * Call at the top of a staff-only or money-moving function, after auth.getUser(token) succeeded.
 * Returns { ok: true } or { ok: false, status: 403, body } to return to the caller.
 * Mode off/shadow never blocks (shadow only logs).
 */
// deno-lint-ignore no-explicit-any
export async function requireStaffAal2(admin: any, token: string, userId: string): Promise<
  { ok: true } | { ok: false; status: number; body: Record<string, unknown> }
> {
  const mode = await staffMfaMode(admin);
  if (mode === "off") return { ok: true };
  const { data } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("enabled", true);
  const roles = (data ?? []).map((r: { role: string }) => String(r.role));
  const gated = mode === "all"
    ? roles.some((r: string) => GATED_STAFF_ROLES.includes(r))
    : mode === "admin"
    ? roles.some((r: string) => ADMIN_ROLES.includes(r))
    : false;
  const wouldBlock = roles.some((r: string) => GATED_STAFF_ROLES.includes(r)) && aalFromToken(token) !== "aal2";
  if (mode === "shadow") {
    if (wouldBlock) console.warn("[staff-mfa] shadow: would block", { userId });
    return { ok: true };
  }
  if (gated && aalFromToken(token) !== "aal2") {
    return {
      ok: false,
      status: 403,
      body: { error: "mfa_required", message: "Verify with your authenticator app to continue." },
    };
  }
  return { ok: true };
}
