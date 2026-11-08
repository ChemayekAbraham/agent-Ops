import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cronBodyAllowed,
  reportAccess,
  sendResponseBody,
  STAFF_MFA_REQUIRED,
  STAFF_MFA_UNCHECKED,
  unverifiedJwtRole,
} from "./access.ts";

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;

const SERVICE = jwt({ role: "service_role", ref: "x" });
const ANON = jwt({ role: "anon", ref: "x" });
const STAFF = jwt({ role: "authenticated", sub: "staff-1" });
const AGENT = jwt({ role: "authenticated", sub: "agent-1" });
const EXPIRED = jwt({ role: "authenticated", sub: "gone" });
// Partner staff with different roles and sign-in levels (the claim is read only after getUser verifies it).
const OPS_AAL1 = jwt({ role: "authenticated", sub: "ops-1", aal: "aal1" });
const OPS_AAL2 = jwt({ role: "authenticated", sub: "ops-1", aal: "aal2" });
const CFO_AAL1 = jwt({ role: "authenticated", sub: "cfo-1", aal: "aal1" });
const CFO_AAL2 = jwt({ role: "authenticated", sub: "cfo-1", aal: "aal2" });
const CFO_NO_AAL = jwt({ role: "authenticated", sub: "cfo-1" });
const DISABLED_CFO = jwt({ role: "authenticated", sub: "ex-cfo-1", aal: "aal1" });

type MfaConfig = { mode?: string | null; error?: boolean; missing?: boolean; throws?: boolean };

/** Fake admin client: getUser by token, user_roles filtered by enabled and the `in` list, staff_mfa_config. */
function fakeAdmin(calls: string[] = [], mfa: MfaConfig = { mode: "shadow" }) {
  const users: Record<string, string> = {
    [STAFF]: "staff-1", [AGENT]: "agent-1", [OPS_AAL1]: "ops-1", [OPS_AAL2]: "ops-1",
    [CFO_AAL1]: "cfo-1", [CFO_AAL2]: "cfo-1", [CFO_NO_AAL]: "cfo-1", [DISABLED_CFO]: "ex-cfo-1",
  };
  const roles: Record<string, Array<{ role: string; enabled: boolean }>> = {
    "staff-1": [{ role: "partner_ops", enabled: true }],
    "agent-1": [{ role: "agent", enabled: true }, { role: "supporter", enabled: true }],
    "ops-1": [{ role: "partner_ops", enabled: true }],
    "cfo-1": [{ role: "cfo", enabled: true }],
    // Partner staff through partner_ops; the admin-list role is disabled, so mode 'admin' asks nothing.
    "ex-cfo-1": [{ role: "partner_ops", enabled: true }, { role: "cfo", enabled: false }],
  };
  return {
    auth: {
      getUser: async (token: string) => {
        calls.push("getUser");
        const id = users[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
    from: (table: string) => {
      calls.push(`from:${table}`);
      if (table === "staff_mfa_config") {
        const q: any = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => {
            if (mfa.throws) throw new Error("network down");
            if (mfa.error) return { data: null, error: { message: "permission denied" } };
            return { data: mfa.missing ? null : { mode: mfa.mode ?? null }, error: null };
          },
        };
        return q;
      }
      let uid = "";
      let enabledOnly = false;
      let allowed: string[] = [];
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          if (col === "user_id") uid = String(v);
          if (col === "enabled") enabledOnly = v === true;
          return q;
        },
        in: (_col: string, list: string[]) => { allowed = list; return q; },
        limit: async () => ({
          data: (roles[uid] ?? [])
            .filter((r) => (!enabledOnly || r.enabled) && allowed.includes(r.role))
            .map(({ role }) => ({ role })),
          error: null,
        }),
      };
      return q;
    },
  };
}
const req = (headers: Record<string, string> = {}) => new Request("https://x/functions/v1/partner-ops-daily-report", { method: "POST", headers });
const env = { serviceKey: SERVICE, reportSecret: "s3cret-value" };

Deno.test("service key and report secret -> full, no database calls", async () => {
  const calls: string[] = [];
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${SERVICE}` }), fakeAdmin(calls), env), { mode: "full" });
  assertEquals(await reportAccess(req({ "x-report-secret": "s3cret-value" }), fakeAdmin(calls), env), { mode: "full" });
  assertEquals(calls, []);
});

Deno.test("partner-staff JWT -> full; agent JWT -> 403; bad JWT -> 401", async () => {
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${STAFF}` }), fakeAdmin(), env), { mode: "full" });
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${AGENT}` }), fakeAdmin(), env), { mode: "deny", status: 403 });
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${EXPIRED}` }), fakeAdmin(), env), { mode: "deny", status: 401 });
});

Deno.test("no auth, anon key, wrong secret, forged service_role claim -> cron (default send only)", async () => {
  for (const h of <Array<Record<string, string>>>[
    {},
    { apikey: ANON },
    { Authorization: `Bearer ${ANON}`, apikey: ANON },
    { "x-report-secret": "wrong" },
    { Authorization: `Bearer ${jwt({ role: "service_role" })}` }, // unverified claim is never trusted
    { Authorization: "Bearer not-a-jwt" },
  ]) {
    assertEquals(await reportAccess(req(h), fakeAdmin(), env), { mode: "cron" }, JSON.stringify(h));
  }
  // No REPORT_SECRET configured: an empty header never matches.
  assertEquals(await reportAccess(req({ "x-report-secret": "" }), fakeAdmin(), { serviceKey: SERVICE }), { mode: "cron" });
});

Deno.test("cron mode: only today's default daily send", () => {
  const today = "2026-11-07";
  assert(cronBodyAllowed({}, today));
  assert(cronBodyAllowed(null, today));
  assert(cronBodyAllowed({ date: today }, today)); // what the cron sends
  assert(cronBodyAllowed({ date: today, period: "daily" }, today));
  for (const body of [
    { preview: true }, { pdf: true }, { to: "x@y.z" }, { force: true }, { start: "2026-01-01" }, { end: today },
    { preview: false }, { date: "2026-01-01" }, { period: "monthly" }, { date: 20261107 },
  ]) {
    assert(!cronBodyAllowed(body as Record<string, unknown>, today), JSON.stringify(body));
  }
});

Deno.test("unverifiedJwtRole", () => {
  assertEquals(unverifiedJwtRole(STAFF), "authenticated");
  assertEquals(unverifiedJwtRole(ANON), "anon");
  assertEquals(unverifiedJwtRole("abc"), null);
  assertEquals(unverifiedJwtRole("a.%%%.c"), null);
  assertEquals(unverifiedJwtRole("sb_secret_abcdef"), null);
});

Deno.test("send response: full access gets the send result; cron mode gets only success and skipped", () => {
  const sent = {
    date: "2026-11-07", period: "daily", window: { start: "2026-11-07", end: "2026-11-07" },
    recipients: ["ops@example.com"], results: { "ops@example.com": "sent with PDF" }, pdf_bytes: 1234, usedQueue: false,
    kpis: { total_capital: 9_000_000, paid_out_amount: 100_000 },
  };
  const skipped = { date: "2026-11-07", period: "daily", skipped: true, reason: "Already sent" };
  assertEquals(sendResponseBody("full", sent), { success: true, report: sent });
  assertEquals(sendResponseBody("full", skipped), { success: true, report: skipped });
  assertEquals(sendResponseBody("cron", sent), { success: true, skipped: false });
  assertEquals(sendResponseBody("cron", skipped), { success: true, skipped: true });
  assertEquals(sendResponseBody("cron", null), { success: true, skipped: false });
  const cronText = JSON.stringify(sendResponseBody("cron", sent));
  for (const leak of ["ops@example.com", "recipients", "results", "kpis", "9000000", "pdf_bytes", "Already sent"]) {
    assert(!cronText.includes(leak), leak);
  }
});

Deno.test("staff two-step: shadow, off or no config row -> full at aal1 (production today)", async () => {
  for (const mfa of <MfaConfig[]>[{ mode: "shadow" }, { mode: "off" }, { mode: null }, { missing: true }]) {
    for (const token of [OPS_AAL1, CFO_AAL1, CFO_NO_AAL]) {
      assertEquals(await reportAccess(req({ Authorization: `Bearer ${token}` }), fakeAdmin([], mfa), env), { mode: "full" }, JSON.stringify(mfa));
    }
  }
});

Deno.test("staff two-step: mode 'all' -> any partner staff below aal2 is refused with the MFA message", async () => {
  const mfa = { mode: "all" };
  const denied = { mode: "deny", status: 403, error: STAFF_MFA_REQUIRED } as const;
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${OPS_AAL1}` }), fakeAdmin([], mfa), env), denied);
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${CFO_AAL1}` }), fakeAdmin([], mfa), env), denied);
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${CFO_NO_AAL}` }), fakeAdmin([], mfa), env), denied); // no claim = aal1
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${STAFF}` }), fakeAdmin([], mfa), env), denied);
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${OPS_AAL2}` }), fakeAdmin([], mfa), env), { mode: "full" });
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${CFO_AAL2}` }), fakeAdmin([], mfa), env), { mode: "full" });
  // Not partner staff stays the plain 403; a bad token stays 401.
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${AGENT}` }), fakeAdmin([], mfa), env), { mode: "deny", status: 403 });
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${EXPIRED}` }), fakeAdmin([], mfa), env), { mode: "deny", status: 401 });
});

Deno.test("staff two-step: mode 'admin' -> only enabled admin-list roles need aal2", async () => {
  const mfa = { mode: "admin" };
  assertEquals(
    await reportAccess(req({ Authorization: `Bearer ${CFO_AAL1}` }), fakeAdmin([], mfa), env),
    { mode: "deny", status: 403, error: STAFF_MFA_REQUIRED },
  );
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${CFO_AAL2}` }), fakeAdmin([], mfa), env), { mode: "full" });
  // partner_ops is not on the admin list.
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${OPS_AAL1}` }), fakeAdmin([], mfa), env), { mode: "full" });
  // A disabled cfo row is ignored, as in staff_mfa_ok().
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${DISABLED_CFO}` }), fakeAdmin([], mfa), env), { mode: "full" });
});

Deno.test("staff two-step: aal2 needs no config read; an unreadable config fails closed", async () => {
  const calls: string[] = [];
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${OPS_AAL2}` }), fakeAdmin(calls, { mode: "all" }), env), { mode: "full" });
  assertEquals(calls, ["getUser", "from:user_roles"]);
  const unchecked = { mode: "deny", status: 403, error: STAFF_MFA_UNCHECKED } as const;
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${OPS_AAL1}` }), fakeAdmin([], { error: true }), env), unchecked);
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${OPS_AAL1}` }), fakeAdmin([], { throws: true }), env), unchecked);
  // Service key and cron mode never read the config.
  const calls2: string[] = [];
  assertEquals(await reportAccess(req({ Authorization: `Bearer ${SERVICE}` }), fakeAdmin(calls2, { mode: "all" }), env), { mode: "full" });
  assertEquals(await reportAccess(req({ apikey: ANON }), fakeAdmin(calls2, { mode: "all" }), env), { mode: "cron" });
  assertEquals(calls2, []);
});
