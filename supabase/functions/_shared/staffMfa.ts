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
