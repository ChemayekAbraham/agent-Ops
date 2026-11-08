// E12 partner-ops-daily-report access (design v2 section 3.9.1) and E13 agent-assistant tool degradation
// (section 3.5.10), both through the real handlers.
import { aiReplies, aiRequests, call, eq, loadHandler, ok_, rpcCalls, SERVICE_KEY, signIn, state, table } from "./harness.ts";
import { reset } from "./fake_supabase.ts";
import { STAFF_MFA_ADMIN_ROLES, STAFF_MFA_ALL_ROLES } from "../../../functions/partner-ops-daily-report/access.ts";

const report = await loadHandler("partner-ops-daily-report");
const assistant = await loadHandler("agent-assistant");

// ---- E12 -------------------------------------------------------------------------------------------

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;
const STAFF = jwt({ role: "authenticated", sub: "staff" });
const AGENT_JWT = jwt({ role: "authenticated", sub: "agent" });
const FORGED = jwt({ role: "authenticated", sub: "nobody" });
const ANON = jwt({ role: "anon" });
const TODAY_EAT = "2026-11-07"; // the harness clock is 2026-11-07 09:00 UTC (12:00 EAT)

function setupReport() {
  reset();
  signIn(STAFF, { id: "staff-1" }, ["partner_ops"]);
  signIn(AGENT_JWT, { id: "agent-1" }, ["agent", "supporter"]);
  // Today's daily report was already sent: the default send path answers "Already sent" without
  // building the report, which is enough to prove the request got past the access check.
  table("system_events").push({ id: "ev-1", event_type: "partner_ops_daily_report", metadata: { date: TODAY_EAT, period: "daily" } });
}
const reportCall = (body: unknown, headers: Record<string, string> = {}) => call(report, { body, headers });
const reachedSend = () => state.reads.some((r) => r.table === "system_events");

Deno.test("E12.1 no auth: preview / to / pdf / force / another date -> 401; nothing read", async () => {
  for (const body of [{ preview: true }, { to: "someone@example.com" }, { pdf: true }, { force: true }, { date: "2026-01-01" }, { start: "2026-11-01" }]) {
    setupReport();
    const r = await reportCall(body);
    eq([r.status, r.body.error], [401, "Sign in as partner staff to use report options."], JSON.stringify(body));
    ok_(!reachedSend(), "no report work");
  }
});

Deno.test("E12.2 no auth (or the anon apikey) + empty body -> today's default send (the existing cron keeps working)", async () => {
  // E4: without credentials the reply says only that it ran and whether it skipped (E15.4).
  setupReport();
  let r = await reportCall({});
  eq([r.status, r.body], [200, { success: true, skipped: true }], "default send");
  ok_(reachedSend(), "the send path ran");
  setupReport();
  r = await reportCall({ date: TODAY_EAT }, { apikey: ANON });
  eq([r.status, r.body], [200, { success: true, skipped: true }], "the live cron's body + apikey");
  setupReport();
  r = await reportCall({}, { Authorization: `Bearer ${ANON}`, apikey: ANON });
  eq(r.status, 200, "anon bearer");
});

Deno.test("E12.3 service key and partner-staff JWT -> full options; agent JWT -> 403; bad user JWT -> 401", async () => {
  setupReport();
  let r = await reportCall({ to: "cfo@example.com" }, { Authorization: `Bearer ${SERVICE_KEY}` });
  eq(r.status, 200, "service key");
  setupReport();
  r = await reportCall({ to: "cfo@example.com" }, { Authorization: `Bearer ${STAFF}` });
  eq(r.status, 200, "partner staff");
  setupReport();
  r = await reportCall({ to: "cfo@example.com" }, { Authorization: `Bearer ${AGENT_JWT}` });
  eq([r.status, r.body.error], [403, "Partner staff only."], "agent");
  ok_(!reachedSend(), "no report work for the agent");
  setupReport();
  r = await reportCall({}, { Authorization: `Bearer ${FORGED}` });
  eq(r.status, 401, "unverifiable user token");
});

// ---- E12 staff two-step sign-in (round 4 U2: access.ts mirrors production staff_mfa_ok()) ----------

const STAFF_AAL1 = jwt({ role: "authenticated", sub: "staff", aal: "aal1" });
const STAFF_AAL2 = jwt({ role: "authenticated", sub: "staff", aal: "aal2" });
const ADMIN_AAL1 = jwt({ role: "authenticated", sub: "cfo", aal: "aal1" });
const DISABLED_CFO_AAL1 = jwt({ role: "authenticated", sub: "ops2", aal: "aal1" });
const MFA_REQUIRED = "Staff two-step sign-in required";
const MFA_UNCHECKED = "Could not check staff two-step sign-in. Please try again.";

function setupMfa(mode: string | null) {
  setupReport();
  // STAFF (no aal claim) and STAFF_AAL1/AAL2 are the same partner_ops user.
  signIn(STAFF_AAL1, { id: "staff-1" });
  signIn(STAFF_AAL2, { id: "staff-1" });
  signIn(ADMIN_AAL1, { id: "cfo-1" }, ["cfo"]);
  // partner_ops enabled, cfo present but DISABLED: not on the admin list for staff_mfa_ok().
  signIn(DISABLED_CFO_AAL1, { id: "ops-2" }, ["partner_ops"]);
  table("user_roles").push({ id: "r-disabled", user_id: "ops-2", role: "cfo", enabled: false });
  if (mode !== null) table("staff_mfa_config").push({ id: true, mode });
  else table("staff_mfa_config");
}
const configReads = () => state.reads.filter((r) => r.table === "staff_mfa_config").length;
const staffCall = (token: string) => reportCall({ to: "cfo@example.com" }, { Authorization: `Bearer ${token}` });

Deno.test("E12.4 staff_mfa_config 'shadow' (production today), 'off' or no row -> partner staff at aal1 (or no aal claim) keep full options", async () => {
  for (const mode of ["shadow", "off", null]) {
    for (const [who, token] of [["aal1", STAFF_AAL1], ["no aal claim", STAFF], ["admin-list role at aal1", ADMIN_AAL1]] as [string, string][]) {
      setupMfa(mode);
      const r = await staffCall(token);
      eq(r.status, 200, `${mode ?? "no row"}, ${who}`);
      ok_(reachedSend(), `${mode ?? "no row"}, ${who}: the send path ran`);
    }
  }
});

Deno.test("E12.5 mode 'all': partner staff below aal2 (or with no aal claim) -> 403 with the two-step message, no report work; aal2 -> full with no config read", async () => {
  for (const [who, token] of [["aal1", STAFF_AAL1], ["no aal claim", STAFF], ["admin-list role at aal1", ADMIN_AAL1]] as [string, string][]) {
    setupMfa("all");
    const r = await staffCall(token);
    eq([r.status, r.body], [403, { success: false, error: MFA_REQUIRED }], who);
    ok_(!reachedSend(), `${who}: no report work`);
  }
  setupMfa("all");
  const r = await staffCall(STAFF_AAL2);
  eq(r.status, 200, "aal2");
  eq(configReads(), 0, "aal2 reads no config");
});

Deno.test("E12.6 mode 'admin': only an ENABLED admin-list role needs aal2 (partner_ops and a disabled cfo row pass at aal1)", async () => {
  setupMfa("admin");
  let r = await staffCall(ADMIN_AAL1);
  eq([r.status, r.body.error], [403, MFA_REQUIRED], "enabled cfo at aal1");
  ok_(!reachedSend(), "no report work for the refused cfo");
  for (const [who, token] of [["partner_ops aal1", STAFF_AAL1], ["partner_ops, no aal claim", STAFF], ["partner_ops with a disabled cfo row", DISABLED_CFO_AAL1]] as [string, string][]) {
    setupMfa("admin");
    r = await staffCall(token);
    eq(r.status, 200, who);
  }
});

Deno.test("E12.7 an unreadable staff_mfa_config fails closed (403, try-again message); a non-staff user still gets 'Partner staff only.' with no config read", async () => {
  setupMfa("all");
  state.failSelect = (t) => (t === "staff_mfa_config" ? { code: "XX000", message: "boom" } : null);
  let r = await staffCall(STAFF_AAL1);
  eq([r.status, r.body], [403, { success: false, error: MFA_UNCHECKED }], "config read error");
  ok_(!reachedSend(), "no report work");

  setupMfa("shadow");
  state.failSelect = (t) => (t === "staff_mfa_config" ? { code: "XX000", message: "boom" } : null);
  r = await staffCall(STAFF_AAL1);
  eq(r.status, 403, "fails closed even when production is in shadow (the mode cannot be read)");

  setupMfa("all");
  r = await staffCall(AGENT_JWT);
  eq([r.status, r.body.error, configReads()], [403, "Partner staff only.", 0], "agent: role check first");
  setupMfa("all");
  r = await staffCall(FORGED);
  eq([r.status, configReads()], [401, 0], "unverifiable token: 401 before any config read");
});

Deno.test("E12.8 mode 'all': the service key, the cron (no credentials) and the anon apikey never read the config and keep working", async () => {
  setupMfa("all");
  let r = await reportCall({ to: "cfo@example.com" }, { Authorization: `Bearer ${SERVICE_KEY}` });
  eq([r.status, configReads()], [200, 0], "service key");
  setupMfa("all");
  r = await reportCall({ date: TODAY_EAT }, { apikey: ANON });
  eq([r.status, r.body, configReads()], [200, { success: true, skipped: true }, 0], "cron with the anon apikey");
  setupMfa("all");
  r = await reportCall({});
  eq([r.status, configReads()], [200, 0], "no credentials");
});

Deno.test("E12.9 access.ts role lists equal production staff_mfa_ok() (read with SELECT pg_get_functiondef, 2026-11-07; config mode 'shadow')", () => {
  eq([...STAFF_MFA_ALL_ROLES], ["manager", "super_admin", "coo", "ceo", "cto", "cfo", "cmo", "crm", "hr", "rd", "operations", "employee", "tenant_ops", "agent_ops", "landlord_ops", "partner_ops", "financial_ops", "access_admin", "admin"], "mode 'all' list");
  eq([...STAFF_MFA_ADMIN_ROLES], ["super_admin", "ceo", "cto", "cfo", "coo", "access_admin", "admin"], "mode 'admin' list");
});

// ---- E13 -------------------------------------------------------------------------------------------

const PARTNER_ID = "22222222-2222-4222-8222-222222222222";

function setupAssistant(toolAnswer: { data?: unknown; error?: { code: string; message: string } | null }) {
  reset();
  aiReplies.length = 0;
  aiRequests.length = 0;
  signIn("jwt-partner", { id: PARTNER_ID, email: "pat@example.com" }, ["supporter"]);
  state.rpc.assistant_has_access = () => ({ data: true, error: null });
  state.rpc.assistant_is_agent = () => ({ data: false, error: null });
  state.rpc.assistant_is_partner = () => ({ data: true, error: null });
  state.rpc.assistant_partner_new_portfolio_rate = () => ({ data: toolAnswer.data ?? null, error: toolAnswer.error ?? null });
  aiReplies.push(
    { model: "m", choices: [{ message: { content: JSON.stringify({ category: "allowed" }) } }] },
    {
      model: "m",
      choices: [{ message: { content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "get_my_new_portfolio_rate", arguments: "{}" } }] } }],
    },
    { model: "m", choices: [{ message: { content: "I cannot see a rate for a new portfolio yet. Partner Ops can tell you." } }] },
  );
}
const ask = () => call(assistant, { jwt: "jwt-partner", body: { action: "message", message: "What would a new portfolio earn for me?", page: "funder_dashboard" } });

Deno.test("E13.1 a tool whose SQL is missing (PGRST202) degrades to { available: false } and the turn continues", async () => {
  setupAssistant({ error: { code: "PGRST202", message: "Could not find the function public.assistant_partner_new_portfolio_rate" } });
  const r = await ask();
  eq([r.status, r.body.outcome], [200, "answered"], `turn: ${JSON.stringify(r.body)}`);
  eq(r.body.reply, "I cannot see a rate for a new portfolio yet. Partner Ops can tell you.", "reply");
  const call1 = rpcCalls("assistant_partner_new_portfolio_rate")[0];
  eq([call1.payload, call1.client!.headers.Authorization], [{}, "Bearer jwt-partner"], "runs as the user, no identity argument");
  const toolMsg = aiRequests[2].messages.find((m: { role: string }) => m.role === "tool");
  eq(JSON.parse(toolMsg.content), { untrusted_data: { available: false } }, "tool content");
});

Deno.test("E13.2 any other tool error still fails the turn (no silent data)", async () => {
  setupAssistant({ error: { code: "XX000", message: "boom" } });
  const r = await ask();
  eq(r.body.outcome, "error", "outcome");
});

Deno.test("E13.3 the tool's answer reaches the model as untrusted data", async () => {
  setupAssistant({ data: { available: true, rate_percent: 10 } });
  aiReplies[2] = { model: "m", choices: [{ message: { content: "A new portfolio would earn 10% a month." } }] };
  const r = await ask();
  eq(r.body.outcome, "answered", `turn: ${JSON.stringify(r.body)}`);
  const toolMsg = aiRequests[2].messages.find((m: { role: string }) => m.role === "tool");
  eq(JSON.parse(toolMsg.content), { untrusted_data: { available: true, rate_percent: 10 } }, "tool content");
});
