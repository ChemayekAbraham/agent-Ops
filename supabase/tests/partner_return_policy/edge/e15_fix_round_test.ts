// E15: the review fixes E1-E6 through the real handlers (fix round after the Phase 4 review).
//   E1 Nexa (welile-ai-chat): a signed-in caller's estimate without a rate uses their OWN new-portfolio
//      rate (partner_quote_rate('me'), read at most once per request); unreadable -> no figure, never the
//      public rate. Anonymous callers keep the public rate.
//   E2 submit-partner-form: an existing account gets no monthly figure once the switch is on.
//   E3 import-partners: origin's 1% lower bound and message are back.
//   E4 partner-ops-daily-report: the no-credentials (cron) reply is { success, skipped } only.
//   E5 the eight rate-bearing email senders: figures only to a confirmed login email unless the row's
//      rate is public (rateIsPublicForRow -> rateEmailTarget); at most one login-email RPC per request.
//   E6 partner-ops-daily-report: note_links_held > 0 adds a watch item (HTML, PDF, text) and is stored.
// deno-lint-ignore-file no-explicit-any
import {
  aiReplies,
  aiRequests,
  call,
  emails,
  eq,
  fetchRoutes,
  invokes,
  loadHandler,
  loadHandlerVariant,
  ok_,
  POLICY_OFF,
  POLICY_OFF_AFTER_CUTOFF,
  POLICY_ON,
  policyRpc,
  rpcCalls,
  SERVICE_KEY,
  signIn,
  state,
  table,
} from "./harness.ts";
import { reset } from "./fake_supabase.ts";
import { _resetPolicyCacheForTests } from "../../../functions/_shared/partnerReturnPolicy.ts";
import { RATE_UNAVAILABLE_ERROR } from "../../../functions/_shared/nexaTools.ts";
import {
  AGENT,
  inlineTopupMergeOn,
  LOGIN_EMAIL,
  PARTNER,
  PARTNER2,
  PF,
  PROFILE_EMAIL,
  type RateRow,
  seedInvestForPartner,
  seedPendingPortfolio,
  seedRoiTopups,
  seedTopupOperation,
  seedTopupPortfolio,
  topupBody,
  world,
  type World,
} from "./seed.ts";

const loginRpcs = () => rpcCalls("partner_confirmed_login_emails").length;

// =====================================================================================================
// E1 welile-ai-chat: the estimate's default rate for a signed-in caller

const chat = await loadHandler("welile-ai-chat");
let chatUser = 0;

/** A fresh signed-in partner per request (the function rate-limits 15 requests per user per minute and
 *  the harness clock is fixed). */
function chatSetup(policy: unknown, quote: { data?: unknown; error?: { code: string; message: string } }) {
  _resetPolicyCacheForTests();
  reset();
  policyRpc(policy);
  aiReplies.length = 0;
  aiRequests.length = 0;
  const id = `e1e1e1e1-0000-4000-8000-${String(++chatUser).padStart(12, "0")}`;
  const jwt = `jwt-e15-chat-${chatUser}`;
  signIn(jwt, { id, email: `chat${chatUser}@example.com` }, ["supporter"]);
  state.rpc.partner_quote_rate = () => ({ data: quote.data ?? null, error: quote.error ?? null });
  return jwt;
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolTurn = (...calls: unknown[]) => ({ choices: [{ message: { content: "", tool_calls: calls } }] });
const finalTurn = (text: string) => ({ choices: [{ message: { content: text } }] });
const ask = (jwt?: string) =>
  call(chat, {
    jwt,
    body: { messages: [{ role: "user", content: "How much would I earn as a supporter partner returns on UGX 1,000,000?" }] },
    headers: { "x-forwarded-for": `10.1.0.${++chatUser % 250}` },
  });
/** Tool results the model received, in order: [tool name, parsed content]. */
function toolResults(): [string, any][] {
  const last = aiRequests[aiRequests.length - 1];
  const names = new Map<string, string>();
  for (const m of last.messages) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  return last.messages.filter((m: any) => m.role === "tool").map((m: any) => [names.get(m.tool_call_id) ?? "?", JSON.parse(m.content)]);
}
const estimateDescription = (i = 0) =>
  aiRequests[i].tools.find((t: any) => t.function.name === "estimate_supporter_returns").function.description as string;

Deno.test("E15.1a signed in, no rate: the estimate uses the caller's own rate (20), not the public 10", async () => {
  const jwt = chatSetup(POLICY_ON, { data: 20 });
  aiReplies.push(toolTurn(toolCall("c1", "estimate_supporter_returns", { amount: 1_000_000 })), finalTurn("About UGX 200,000 a month."));
  const r = await ask(jwt);
  eq(r.status, 200, "status");
  const [[name, est]] = toolResults();
  eq([name, est.monthlyRatePercent, est.monthlyBreakdown[0].returns, est.totalReturns, est.months], ["estimate_supporter_returns", 20, 200_000, 2_400_000, 12], "estimate");
  const q = rpcCalls("partner_quote_rate");
  eq(q.map((c) => [c.payload, c.client!.headers.Authorization]), [[{ p_quote_for: "me", p_partner_id: null }, `Bearer ${jwt}`]], "one partner_quote_rate('me') as the caller");
});

Deno.test("E15.1b get_my_returns_rate and two estimates in one request -> one partner_quote_rate read", async () => {
  const jwt = chatSetup(POLICY_ON, { data: 18 });
  aiReplies.push(
    toolTurn(toolCall("c1", "get_my_returns_rate", {}), toolCall("c2", "estimate_supporter_returns", { amount: 1_000_000 })),
    toolTurn(toolCall("c3", "estimate_supporter_returns", { amount: 500_000, mode: "compound", months: 2 })),
    finalTurn("Done."),
  );
  const r = await ask(jwt);
  eq(r.status, 200, "status");
  const res = toolResults();
  eq(res.map(([n]) => n), ["get_my_returns_rate", "estimate_supporter_returns", "estimate_supporter_returns"], "tools ran");
  eq(res[0][1], { rate: 18 }, "own rate");
  eq([res[1][1].monthlyRatePercent, res[1][1].totalReturns], [18, 2_160_000], "simple estimate at 18");
  eq([res[2][1].monthlyRatePercent, res[2][1].monthlyBreakdown.map((m: any) => m.returns)], [18, [90_000, 106_200]], "compound estimate at 18");
  eq(rpcCalls("partner_quote_rate").length, 1, "read once per request");
});

Deno.test("E15.1c signed in, own rate unreadable (error or null) -> RATE_UNAVAILABLE_ERROR, never the public rate", async () => {
  for (const quote of [{ error: { code: "42501", message: "AUTH_REQUIRED" } }, { data: null }, { data: "abc" }]) {
    const jwt = chatSetup(POLICY_OFF, quote);
    aiReplies.push(toolTurn(toolCall("c1", "estimate_supporter_returns", { amount: 1_000_000 })), finalTurn("I cannot give a figure right now."));
    const r = await ask(jwt);
    eq(r.status, 200, "status");
    eq(toolResults()[0][1], { error: RATE_UNAVAILABLE_ERROR }, `no figure for ${JSON.stringify(quote)}`);
  }
});

Deno.test("E15.1d signed in with an explicit rate (an existing portfolio or the public rate) -> that rate, no own-rate read", async () => {
  const jwt = chatSetup(POLICY_ON, { data: 20 });
  aiReplies.push(toolTurn(toolCall("c1", "estimate_supporter_returns", { amount: 1_000_000, rate: 10 })), finalTurn("New partners: UGX 100,000 a month."));
  await ask(jwt);
  eq([toolResults()[0][1].monthlyRatePercent, rpcCalls("partner_quote_rate").length], [10, 0], "explicit rate honoured");
});

Deno.test("E15.1e anonymous: an estimate without a rate uses the public rate (15 off, 10 on); no own-rate tool or read", async () => {
  for (const [policy, want] of [[POLICY_OFF, 15], [POLICY_ON, 10]] as const) {
    chatSetup(policy, { data: 20 });
    aiReplies.push(toolTurn(toolCall("c1", "estimate_supporter_returns", { amount: 1_000_000 })), finalTurn("Estimate."));
    const r = await ask();
    eq(r.status, 200, "status");
    eq(toolResults()[0][1].monthlyRatePercent, want, `public rate, switch ${(policy as any).enabled ? "on" : "off"}`);
    eq(rpcCalls("partner_quote_rate").length, 0, "no own-rate read");
    ok_(!aiRequests[0].tools.some((t: any) => t.function.name === "get_my_returns_rate"), "no own-rate tool");
  }
  // A get_my_returns_rate call the model invents anyway is refused and recorded.
  chatSetup(POLICY_ON, { data: 20 });
  aiReplies.push(toolTurn(toolCall("c1", "get_my_returns_rate", {})), finalTurn("Please sign in."));
  await ask();
  eq(toolResults()[0][1], { error: "Sign in at welileapp.com to see your own rate." }, "refused");
  eq(rpcCalls("partner_quote_rate").length, 0, "no read");
});

Deno.test("E15.1f tool descriptions: signed in -> omit for your own rate, pass the public rate for new partners", async () => {
  let jwt = chatSetup(POLICY_ON, { data: 20 });
  aiReplies.push(finalTurn("Hi."));
  await ask(jwt);
  let d = estimateDescription();
  ok_(d.includes("Omit rate to use the signed-in caller's own rate for a new portfolio") && d.includes("pass rate 10 (the new-partner rate, 10% a month now)"), d);
  chatSetup(POLICY_ON, { data: 20 });
  aiReplies.push(finalTurn("Hi."));
  await ask();
  d = estimateDescription();
  ok_(d.includes("Omit rate for a new partner (10% a month now).") && !d.includes("signed-in"), d);
  // Signed in while the public rate is unknown: no figure for new partners either.
  jwt = chatSetup(null, { data: 20 });
  state.rpc.get_partner_return_policy = () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
  aiReplies.push(finalTurn("Hi."));
  await ask(jwt);
  ok_(estimateDescription().includes("none is available right now, so give no figure"), estimateDescription());
});

// =====================================================================================================
// E2 submit-partner-form: no public figure for an existing account once the switch is on

const partnerForm = await loadHandler("submit-partner-form");
function seedForm(policy: unknown, existing: boolean) {
  _resetPolicyCacheForTests();
  reset();
  policyRpc(policy);
  table("agent_form_tokens").push({ id: "t1", token: "tok", agent_id: AGENT, is_active: true, expires_at: "2027-01-01T00:00:00Z", uses_count: 0, max_uses: 10 });
  if (existing) table("profiles").push({ id: PARTNER, full_name: "Pat Partner", email: PROFILE_EMAIL, phone: "+256772000999" });
}
const form = () =>
  call(partnerForm, {
    body: {
      token: "tok", agent_id: AGENT, full_name: "Pat Partner Test", phone: "0772000999", email: "pat.new@example.com",
      residence: "Kira", investment_amount: 1_000_000, payout_method: "mobile_money", mobile_money_number: "0772000999",
    },
  });

Deno.test("E15.2 submit-partner-form: existing account + switch on -> monthly_roi null; off or a new person -> the public figure", async () => {
  for (const [policy, existing, want] of [
    [POLICY_ON, true, null], [POLICY_OFF, true, 150_000], [POLICY_ON, false, 100_000], [POLICY_OFF, false, 150_000],
  ] as const) {
    seedForm(policy, existing);
    const r = await form();
    eq([r.status, r.body.success, r.body.existing, r.body.monthly_roi, r.body.partner_id === PARTNER], [200, true, existing, want, existing],
      `switch ${(policy as any).enabled ? "on" : "off"}, existing ${existing}`);
  }
});

// =====================================================================================================
// E3 import-partners: origin's lower bound

const importPartners = await loadHandler("import-partners");
const ORIGIN_MSG = (amount: unknown, rate: unknown, dur: unknown) =>
  `Invalid portfolio data: amount ${amount}, return ${rate}%, duration ${dur} months. Amount must be at least UGX 50,000, return must be at least 1%, and duration must be at least 1 month.`;
function importSetup() {
  _resetPolicyCacheForTests();
  world({});
  state.rpc.profile_ids_by_emails = () => ({ data: [], error: null });
}
const imp = (portfolios: any[]) =>
  call(importPartners, { jwt: "jwt-manager", body: { partners: [{ partner_name: "Paper Partner", phone: "+256701000001", email: "paper@example.com", portfolios }] } });
const pf = (extra: Record<string, unknown>) => ({ amount: 100_000, durationMonths: 12, roiMode: "monthly_payout", ...extra });

Deno.test("E15.3a import-partners: a typed rate below 1% (0.5, 0, -3, '0.99') -> origin's message word for word, nothing created", async () => {
  for (const rate of [0.5, 0, -3, "0.99"]) {
    importSetup();
    const r = await imp([pf({ roiPercentage: rate })]);
    eq([r.status, r.body.portfoliosCreated, r.body.errors], [200, 0, [{ partner: "Paper Partner", error: ORIGIN_MSG(100_000, rate, 12) }]], `rate ${rate}`);
    eq(table("investor_portfolios").length, 0, "no portfolio");
  }
});

Deno.test("E15.3b import-partners: bad amount or duration with a typed rate -> origin's message; above 100 / text -> the Phase 4 message", async () => {
  for (const [row, msg] of [
    [pf({ amount: 10_000, roiPercentage: 15 }), ORIGIN_MSG(10_000, 15, 12)],
    [pf({ durationMonths: 0, roiPercentage: 20 }), ORIGIN_MSG(100_000, 20, 0)],
    [pf({ roiPercentage: 150 }), "Monthly Returns rate must be above 0% and at most 100% (got 150)."],
    [pf({ roiPercentage: "abc" }), "Monthly Returns rate must be above 0% and at most 100% (got abc)."],
  ] as const) {
    importSetup();
    const r = await imp([row]);
    eq([r.body.portfoliosCreated, r.body.errors], [0, [{ partner: "Paper Partner", error: msg }]], JSON.stringify(row));
  }
});

Deno.test("E15.3c import-partners: 1% and a blank rate are accepted (blank -> the gate's rate)", async () => {
  importSetup();
  const r = await imp([pf({ roiPercentage: 1 }), pf({ amount: 200_000, roiPercentage: "" }), pf({ amount: 300_000 })]);
  eq([r.body.portfoliosCreated, r.body.errors.length], [3, 0], "created");
  eq(table("investor_portfolios").map((p) => [p.investment_amount, p.roi_percentage, p.rate_basis]).sort(),
    [[100_000, 1, "typed_switch_off"], [200_000, 15, "switch_off"], [300_000, 15, "switch_off"]], "stored");
});

// =====================================================================================================
// E4 / E6 partner-ops-daily-report

const report = await loadHandler("partner-ops-daily-report");
const TODAY_EAT = "2026-11-07";

function returnsCheck(extra: Record<string, unknown> = {}) {
  return {
    window: { start: TODAY_EAT, end: TODAY_EAT },
    policy: { enabled: false, release_ready: false, cutoff_at: null, enabled_at: null, public_rate: 15, new_contract_rate: 10 },
    new_portfolios: [{ basis: "switch_off", rate: 15, count: 2, amount: 2_000_000 }],
    notes: [],
    cfo_queue: { pending: 0, oldest_pending_at: null, approved_in_window: 0, rejected_in_window: 0, pending_lowering: 0 },
    conformance: {}, checks_failing: [], release_checks_failing: [], assert_has_phase4_hook: true, drift_open: [],
    monitor: { scheduled: true, active: true, last_end: "2026-11-07T08:55:00Z", last_status: "succeeded" },
    rule_check: { cohort_new_below_own: 0, non_cohort_new_above_public: 0, precutoff_offer_live_non_cohort: 0, open_pending_portfolios: 0, note_windows_beyond_90d: 0 },
    ...extra,
  };
}

/** Raw MIME messages handed to Mailgun (the harness logs FormData bodies as "[binary]"). */
const mimes: string[] = [];
const harnessFetch = globalThis.fetch;
function captureMailgun() {
  mimes.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      const m = init.body.get("message");
      if (m instanceof Blob) mimes.push(await m.text());
    }
    return harnessFetch(input, init);
  }) as typeof fetch;
}
function mimePart(mime: string, type: string): string {
  const at = mime.indexOf(`Content-Type: ${type}`);
  ok_(at >= 0, `no ${type} part`);
  const start = mime.indexOf("\r\n\r\n", at) + 4;
  const b64 = mime.slice(start, mime.indexOf("\r\n\r\n", start)).replace(/\r\n/g, "");
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function reportSetup(rc: unknown) {
  reset();
  fetchRoutes.length = 0;
  fetchRoutes.push({ match: (u) => u.includes("welile-logo.png"), answer: () => ({ status: 404, text: "" }) });
  state.rpc.get_partner_ops_range_report = () => ({ data: { kpis: { total_capital: 5_000_000, active_portfolios: 4 } }, error: null });
  state.rpc.get_partner_ops_compound_topup_outlook = () => ({ data: null, error: null });
  state.rpc.get_partner_return_report = () => ({ data: rc, error: null });
  table("system_events");
  table("promissory_notes");
}
const HELD = "3 promissory notes waiting for Partner Ops: the account never proved the note's phone or email";

Deno.test("E15.4 report, no credentials (cron): the reply is exactly { success, skipped }; full callers keep the report", async () => {
  try {
    captureMailgun();
    // Not yet sent today: the send runs, and the reply carries no recipients, results or figures.
    reportSetup(returnsCheck());
    let r = await call(report, { body: { date: TODAY_EAT }, headers: { apikey: "anon-key" } });
    eq([r.status, r.body], [200, { success: true, skipped: false }], "cron, sent");
    ok_(mimes.length > 0 && table("system_events").length === 1, "the default send still ran");
    // Already sent today.
    r = await call(report, { body: {} });
    eq([r.status, r.body], [200, { success: true, skipped: true }], "cron, already sent");
    // The service key keeps the whole report.
    r = await call(report, { body: {}, headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
    eq([r.status, r.body.success, r.body.report.skipped, r.body.report.reason], [200, true, true, "Already sent"], "service key");
    reportSetup(returnsCheck());
    r = await call(report, { body: { to: "cfo@example.com", force: true }, headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
    eq([r.status, r.body.report.recipients, Object.keys(r.body.report.results)], [200, ["cfo@example.com"], ["cfo@example.com"]], "full send report");
  } finally {
    globalThis.fetch = harnessFetch;
    fetchRoutes.length = 0;
  }
});

Deno.test("E15.6a report: note_links_held 3 -> watch item in the HTML, PDF and text; stored in system_events", async () => {
  try {
    captureMailgun();
    reportSetup(returnsCheck({ note_links_held: 3 }));
    const auth = { Authorization: `Bearer ${SERVICE_KEY}` };
    const html = await call(report, { body: { preview: true }, headers: auth });
    ok_(String(html.body).includes(HELD), "HTML watchlist");
    const pdf = await call(report, { body: { pdf: true }, headers: auth });
    ok_(String(pdf.body).startsWith("%PDF") && String(pdf.body).includes("waiting for Partner Ops"), "PDF watchlist");
    const sent = await call(report, { body: { to: "cfo@example.com", force: true }, headers: auth });
    eq(sent.status, 200, "send");
    const text = mimePart(mimes[0], 'text/plain; charset="UTF-8"');
    ok_(text.includes(`(0 awaiting CFO). ${HELD}.`), `text summary: ${text}`);
    ok_(mimePart(mimes[0], 'text/html; charset="UTF-8"').includes(HELD), "emailed HTML");
    eq(table("system_events").at(-1)!.metadata.returns_check.note_links_held, 3, "stored count");
  } finally {
    globalThis.fetch = harnessFetch;
    fetchRoutes.length = 0;
  }
});

Deno.test("E15.6b report: note_links_held 0 or missing (older SQL) -> no item; stored as 0", async () => {
  for (const rc of [returnsCheck({ note_links_held: 0 }), returnsCheck()]) {
    reportSetup(rc);
    const html = await call(report, { body: { preview: true }, headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
    ok_(!String(html.body).includes("waiting for Partner Ops"), "no item");
    await call(report, { body: { to: "cfo@example.com", force: true }, headers: { Authorization: `Bearer ${SERVICE_KEY}` } });
    eq(table("system_events").at(-1)!.metadata.returns_check.note_links_held, 0, "stored 0");
  }
  fetchRoutes.length = 0;
});

// =====================================================================================================
// E5 rate-bearing emails: who gets the figures

const ON_EXISTING = (login: boolean): World => ({ on: true, person: { rate: 20, basis: "existing_partner" }, ...(login ? { login: { [PARTNER]: LOGIN_EMAIL } } : {}) });
/** Switched on once and off again: the cut-off stays, so personal-rate rules still hold (F1). */
const AFTER_OFF = (login: boolean): World => ({ policy: POLICY_OFF_AFTER_CUTOFF, ...(login ? { login: { [PARTNER]: LOGIN_EMAIL } } : {}) });
const LOGIN_DIFFERS: World = { login: { [PARTNER]: LOGIN_EMAIL } };

interface Case { name: string; world: World; basis?: string | null; to: string; rate: number | undefined; loginReads: number }
/** The D4 routing cases (F1: decided by _shared rateIsPublicForRow / rowRateIsPublic).
 *  Before the first switch-on (no cut-off) every row, a legacy row (rate_basis NULL, written before
 *  Phase 1) included, gets origin's recipient (the profile email) and figures, with no login-email read,
 *  even when the confirmed login email differs. After the cut-off (switch on, or off again) a public
 *  basis keeps the profile email with figures; any other basis or NULL goes to the confirmed login email
 *  with figures, or to the profile email without them (section 8.4 additions, round 3). */
const CASES: Case[] = [
  { name: "no cut-off, public row", world: {}, to: PROFILE_EMAIL, rate: 15, loginReads: 0 },
  { name: "no cut-off, legacy row (basis NULL), login email differs", world: LOGIN_DIFFERS, basis: null, to: PROFILE_EMAIL, rate: 15, loginReads: 0 },
  { name: "no cut-off, legacy row (basis NULL), no login email", world: {}, basis: null, to: PROFILE_EMAIL, rate: 15, loginReads: 0 },
  { name: "on, personal row, login email", world: ON_EXISTING(true), to: LOGIN_EMAIL, rate: 20, loginReads: 1 },
  { name: "on, personal row, no login email", world: ON_EXISTING(false), to: PROFILE_EMAIL, rate: undefined, loginReads: 1 },
  { name: "on, legacy row (basis NULL), login email", world: ON_EXISTING(true), basis: null, to: LOGIN_EMAIL, rate: 20, loginReads: 1 },
  { name: "off after a cut-off, public row", world: AFTER_OFF(true), basis: "switch_off", to: PROFILE_EMAIL, rate: 15, loginReads: 0 },
  { name: "off after a cut-off, legacy row, login email", world: AFTER_OFF(true), basis: null, to: LOGIN_EMAIL, rate: 15, loginReads: 1 },
  { name: "off after a cut-off, legacy row, no login email", world: AFTER_OFF(false), basis: null, to: PROFILE_EMAIL, rate: undefined, loginReads: 1 },
];
const rowFor = (c: Case): RateRow => ({
  roi_percentage: c.world.on ? 20 : 15,
  rate_basis: c.basis !== undefined ? c.basis : (c.world.on ? "existing_partner" : "switch_off"),
});
const monthlyFor = (rate: number | undefined) => (rate === undefined ? undefined : rate * 10_000);

function setup(w: World) {
  _resetPolicyCacheForTests();
  world(w);
}

async function routes(name: string, seed: (c: Case) => void, run: () => Promise<any>, opts: { cases?: Case[]; template?: string; monthly?: boolean } = {}) {
  for (const c of opts.cases ?? CASES) {
    seed(c);
    const r = await run();
    ok_(r.status === 200, `${name} / ${c.name}: status ${r.status} ${JSON.stringify(r.body)}`);
    const m = emails().filter((e: any) => !opts.template || e.templateName === opts.template);
    eq([m.length, m[0]?.recipientEmail, m[0]?.templateData?.roi_percentage, loginRpcs()], [1, c.to, c.rate, c.loginReads], `${name} / ${c.name}`);
    if (opts.monthly) eq(m[0]?.templateData?.monthly_return_amount, monthlyFor(c.rate), `${name} / ${c.name}: monthly Returns`);
  }
}

// ---- coo-invest-for-partner and coo-create-portfolio (insert through the gate: no legacy rows) --------

/** Inserts go through the gate, so the row always has a basis (no legacy rows). */
const NEW_ROW_CASES = CASES.filter((c) => c.basis === undefined);

Deno.test("E15.5a coo-invest-for-partner: D4 routing", async () => {
  const h = await loadHandler("coo-invest-for-partner");
  await routes("coo-invest", (c) => { setup(c.world); seedInvestForPartner(); },
    () => call(h, { jwt: "jwt-manager", body: { partner_id: PARTNER, amount: 1_000_000 } }), { cases: NEW_ROW_CASES });
});

Deno.test("E15.5b coo-create-portfolio (payout and compounding): D4 routing", async () => {
  const h = await loadHandler("coo-create-portfolio");
  for (const roi_mode of ["monthly_payout", "monthly_compounding"]) {
    await routes(`coo-create ${roi_mode}`, (c) => { setup(c.world); seedInvestForPartner(); },
      () => call(h, { jwt: "jwt-manager", body: { partner_id: PARTNER, amount: 1_000_000, roi_mode, duration_months: 12, payment_method: "wallet", source_wallet_user_id: PARTNER } }),
      { cases: NEW_ROW_CASES });
  }
});

// ---- approve-pending-portfolio ------------------------------------------------------------------------

function seedPending(c: Case, extra: Record<string, unknown> = {}) {
  setup(c.world);
  seedPendingPortfolio(rowFor(c), extra);
}

Deno.test("E15.5c approve-pending-portfolio (agreement email): D4 routing, monthly Returns follow the rate", async () => {
  const h = await loadHandler("approve-pending-portfolio");
  await routes("approve-pending", (c) => seedPending(c), () => call(h, { jwt: "jwt-ops", body: { portfolio_id: PF } }), { monthly: true });
});

Deno.test("E15.5d approve-pending-portfolio (self-managed deployment email): D4 routing", async () => {
  const h = await loadHandler("approve-pending-portfolio");
  await routes("approve-pending self-managed", (c) => {
    seedPending(c);
    table("funder_pending_portfolios").push({ portfolio_id: PF, source: "self_managed_house", commitment_id: null, term_months: 12 });
  }, () => call(h, { jwt: "jwt-ops", body: { portfolio_id: PF } }), { template: "partner-self-managed-deployment", monthly: true });
});

// ---- resend-portfolio-invite (functions.invoke) ------------------------------------------------------

Deno.test("E15.5e resend-portfolio-invite: D4 routing; a staff-typed copy shows the rate only for a public row; sent_to and audit", async () => {
  const h = await loadHandler("resend-portfolio-invite");
  for (const c of CASES) {
    seedPending(c, { status: "awaiting_partner_details" });
    const r = await call(h, { jwt: "jwt-ops", body: { portfolio_id: PF, copy_to: "copy@example.com" } });
    eq([r.status, r.body.partner_email, r.body.sent_to], [200, PROFILE_EMAIL, c.to], `${c.name}: response`);
    const publicRow = c.loginReads === 0;
    eq(invokes("send-transactional-email").map((b: any) => [b.recipientEmail, b.templateData.roi_percentage]),
      [[c.to, c.rate], ["copy@example.com", publicRow ? 15 : undefined]], `${c.name}: emails`);
    eq(loginRpcs(), c.loginReads, `${c.name}: login reads`);
    eq(table("audit_logs").find((a: any) => a.action_type === "resend_portfolio_invite")?.metadata?.recipient_email, c.to, `${c.name}: audit recipient`);
  }
  // A copy to the main recipient (any case) is not sent twice.
  for (const c of CASES) {
    seedPending(c, { status: "awaiting_partner_details" });
    await call(h, { jwt: "jwt-ops", body: { portfolio_id: PF, copy_to: c.to.toUpperCase() } });
    eq(invokes("send-transactional-email").length, 1, `${c.name}: no duplicate copy`);
  }
});

// ---- top-up confirmations ------------------------------------------------------------------------------

function seedTopup(c: Case) {
  setup(c.world);
  seedTopupPortfolio(rowFor(c));
}

Deno.test("E15.5f manager-portfolio-topup and coo-wallet-to-portfolio: D4 routing", async () => {
  for (const fn of ["manager-portfolio-topup", "coo-wallet-to-portfolio"]) {
    const h = await loadHandler(fn);
    await routes(fn, seedTopup, () => call(h, { jwt: "jwt-manager", body: topupBody }));
  }
});

function seedApproveTopup(c: Case) {
  seedTopup(c);
  seedTopupOperation();
}

Deno.test("E15.5g approve-portfolio-topup: D4 routing", async () => {
  const h = await loadHandler("approve-portfolio-topup");
  await routes("approve-topup", seedApproveTopup, () => call(h, { jwt: "jwt-manager", body: { portfolio_id: PF, action: "approve" } }));
});

// ---- process-supporter-roi inline top-up merge (disabled in production: run from a flag-on variant) ----

Deno.test("E15.5h process-supporter-roi top-up merge (flag on): D4 routing per row, one profile read and one login read per run", async () => {
  const h = await loadHandlerVariant("process-supporter-roi", "new", inlineTopupMergeOn);
  const A = "cccccccc-0000-4000-8000-0000000000a1", B = "cccccccc-0000-4000-8000-0000000000b2";
  const C = "cccccccc-0000-4000-8000-0000000000c3", D = "cccccccc-0000-4000-8000-0000000000d4";
  setup({ login: { [PARTNER]: LOGIN_EMAIL } });
  seedRoiTopups([
    { id: A, investor: PARTNER, rate_basis: "switch_off", rate: 15 },
    { id: B, investor: PARTNER, rate_basis: "existing_partner", rate: 20 },
    { id: C, investor: PARTNER2, rate_basis: "existing_partner", rate: 18 },
    { id: D, investor: PARTNER2, rate_basis: null, rate: 15 },
  ]);
  const topups = () => emails().filter((e: any) => e.templateName === "partnership-topup").map((e: any) => [e.recipientEmail, e.templateData.roi_percentage]);
  const rows = [
    { id: A, investor: PARTNER, rate_basis: "switch_off", rate: 15 },
    { id: B, investor: PARTNER, rate_basis: "existing_partner", rate: 20 },
    { id: C, investor: PARTNER2, rate_basis: "existing_partner", rate: 18 },
    { id: D, investor: PARTNER2, rate_basis: null, rate: 15 },
  ];
  const r = await call(h, { body: {} });
  eq(r.status, 200, "status");
  // No cut-off yet: the legacy row D is public (origin's recipient and figures); B and C carry a personal basis.
  eq(topups(), [
    [PROFILE_EMAIL, 15], [LOGIN_EMAIL, 20], ["second.profile@example.com", undefined], ["second.profile@example.com", 15],
  ], "emails, no cut-off");
  eq(rpcCalls("partner_confirmed_login_emails").map((c) => [...c.payload.p_ids].sort()), [[PARTNER, PARTNER2].sort()], "one login read, personal rows only");
  eq(state.reads.filter((x: any) => x.table === "profiles" && String(x.select).includes("email")).length, 1, "one profile read");
  eq(rpcCalls("get_partner_return_policy").length, 1, "one policy read for the run (only D has no basis)");

  // After a cut-off (switched off again): D is personal too, and PARTNER2 has no confirmed login email.
  setup({ policy: POLICY_OFF_AFTER_CUTOFF, login: { [PARTNER]: LOGIN_EMAIL } });
  seedRoiTopups(rows);
  await call(h, { body: {} });
  eq(topups(), [
    [PROFILE_EMAIL, 15], [LOGIN_EMAIL, 20], ["second.profile@example.com", undefined], ["second.profile@example.com", undefined],
  ], "emails, after a cut-off");
  eq(loginRpcs(), 1, "still one login read");

  setup({});
  seedRoiTopups([{ id: A, investor: PARTNER, rate_basis: "switch_off", rate: 15 }]);
  await call(h, { body: {} });
  eq([loginRpcs(), emails().map((e: any) => e.recipientEmail)], [0, [PROFILE_EMAIL]], "public rows only: no login read");
});
