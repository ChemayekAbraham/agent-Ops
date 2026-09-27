// Caller identification for edge functions deployed with verify_jwt = false.
//
// With verify_jwt = false the gateway checks nothing, and the public anon key
// ships in the web bundle — so "has an Authorization header" proves nothing.
// These helpers give a function two trustworthy answers:
//   isServiceRoleRequest  — the bearer token IS this project's service-role key
//                           (server-to-server: other edge functions, pg_net).
//   getCaller             — a real signed-in user, verified with Supabase Auth,
//                           plus their enabled roles from user_roles.

// Structural, so callers on any supabase-js build (esm.sh / npm:, any pinned
// version) can pass their service-role client without nominal type clashes.
interface AdminClientLike {
  auth: { getUser(jwt: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

function bearerToken(req: Request): string {
  const h = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export function isServiceRoleRequest(req: Request): boolean {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = bearerToken(req);
  return serviceKey.length > 0 && token.length > 0 && timingSafeEqual(token, serviceKey);
}

export interface Caller {
  userId: string;
  roles: string[];
}

/** Verified signed-in caller, or null for anon / invalid / expired tokens. */
export async function getCaller(admin: AdminClientLike, req: Request): Promise<Caller | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: rows } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", data.user.id)
    .eq("enabled", true);
  return { userId: data.user.id, roles: (rows ?? []).map((r: { role: string }) => r.role) };
}

export function hasAnyRole(caller: Caller | null, roles: readonly string[]): boolean {
  return !!caller && caller.roles.some((r) => roles.includes(r));
}

/** Staff roles that may trigger operational jobs or broadcast to users. */
export const STAFF_ROLES = [
  "super_admin", "admin", "manager", "ceo", "coo", "cfo", "cto", "cmo", "crm",
  "operations", "tenant_ops", "landlord_ops", "agent_ops", "financial_ops", "partner_ops",
] as const;

export function forbidden(corsHeaders: Record<string, string>, status = 401): Response {
  return new Response(JSON.stringify({ error: status === 401 ? "Unauthorized" : "Forbidden" }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
