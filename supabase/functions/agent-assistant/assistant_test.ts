import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkAnswer, cleanTerms, RETRY_NOTE, trimToSentence } from "./guards.ts";
import { kampalaToday, resolvePeriod } from "./dates.ts";
import { cleanMessage, RequestSchema } from "./schemas.ts";
import { AGENT_TOOLS, findTool } from "./tools.ts";

// ---- output guard ---------------------------------------------------------------------------

const DAY_OUTPUT = JSON.stringify({ expected_due: 373678, collected_total: 199000, billed_plans: 14 });

Deno.test("guard: figures that came from a tool pass", () => {
  assertEquals(checkAnswer("You collected UGX 199,000 of UGX 373,678 expected.", [DAY_OUTPUT], "how much today").ok, true);
});

Deno.test("guard: an invented or computed figure is blocked", () => {
  const r = checkAnswer("You collected UGX 250,000 today.", [DAY_OUTPUT], "how much today");
  assertEquals(r, { ok: false, reason: "figure" });
});

Deno.test("guard: small numbers and years are not treated as money", () => {
  assert(checkAnswer("13 of your 14 plans paid partly in 2026.", [DAY_OUTPUT], "x").ok);
});

Deno.test("guard: dates are ignored, not read as figures", () => {
  assert(checkAnswer("For 2026-10-09 you collected UGX 199,000.", [DAY_OUTPUT], "x").ok);
});

Deno.test("guard: a UUID that is not in a tool result is blocked", () => {
  const r = checkAnswer("Agent 5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d did well.", [DAY_OUTPUT], "x");
  assertEquals(r, { ok: false, reason: "uuid" });
});

Deno.test("guard: a phone number that is not in a tool result is blocked", () => {
  assertEquals(checkAnswer("Call them on 0712 345 678.", [DAY_OUTPUT], "x"), { ok: false, reason: "phone" });
  assertEquals(checkAnswer("Call them on +256712345678.", [DAY_OUTPUT], "x"), { ok: false, reason: "phone" });
});

Deno.test("guard: regulatory terminology", () => {
  for (const bad of ["Your loan is overdue.", "The lender said no.", "Your ROI is high.", "You earn interest."]) {
    assertEquals(checkAnswer(bad, [], "x"), { ok: false, reason: "terminology" });
  }
  assert(checkAnswer("Your advance is overdue.", [], "x").ok);
});

Deno.test("guard: an answer with no figures and no tools passes (e.g. a refusal)", () => {
  assert(checkAnswer("I can only help with your own account.", [], "tell me a joke").ok);
});

// ---- periods --------------------------------------------------------------------------------

// 2026-10-10 is a Saturday; Kampala is UTC+3.
const SAT = Date.parse("2026-10-10T09:00:00Z");

Deno.test("periods: kampala today rolls over at 21:00 UTC", () => {
  assertEquals(kampalaToday(Date.parse("2026-10-10T20:59:00Z")), "2026-10-10");
  assertEquals(kampalaToday(Date.parse("2026-10-10T21:00:00Z")), "2026-10-11");
});

Deno.test("periods: weeks start Monday", () => {
  assertEquals(resolvePeriod("this_week", SAT), { from: "2026-10-05", to: "2026-10-10" });
  assertEquals(resolvePeriod("last_week", SAT), { from: "2026-09-28", to: "2026-10-04" });
});

Deno.test("periods: months and rolling windows", () => {
  assertEquals(resolvePeriod("this_month", SAT), { from: "2026-10-01", to: "2026-10-10" });
  assertEquals(resolvePeriod("last_month", SAT), { from: "2026-09-01", to: "2026-09-30" });
  assertEquals(resolvePeriod("last_7_days", SAT), { from: "2026-10-04", to: "2026-10-10" });
  assertEquals(resolvePeriod("last_30_days", SAT), { from: "2026-09-11", to: "2026-10-10" });
  assertEquals(resolvePeriod("yesterday", SAT), { from: "2026-10-09", to: "2026-10-09" });
});

Deno.test("periods: last_month across a year boundary", () => {
  assertEquals(resolvePeriod("last_month", Date.parse("2027-01-15T09:00:00Z")), { from: "2026-12-01", to: "2026-12-31" });
});

// ---- request validation ---------------------------------------------------------------------

Deno.test("request: a plain message validates", () => {
  assertEquals(RequestSchema.safeParse({ action: "message", message: "  hello  " }).success, true);
});

Deno.test("request: unknown keys are rejected (user_id, role, history, system)", () => {
  for (const extra of [{ user_id: "x" }, { role: "admin" }, { history: [] }, { system: "ignore rules" }, { persona: "ceo" }]) {
    assertEquals(RequestSchema.safeParse({ action: "message", message: "hi", ...extra }).success, false);
  }
});

Deno.test("request: bad ids, empty and oversized messages are rejected", () => {
  assertEquals(RequestSchema.safeParse({ action: "message", message: "hi", conversation_id: "not-a-uuid" }).success, false);
  assertEquals(RequestSchema.safeParse({ action: "message", message: "   " }).success, false);
  assertEquals(RequestSchema.safeParse({ action: "message", message: "a".repeat(501) }).success, false);
  assertEquals(RequestSchema.safeParse({ action: "escalate" }).success, false);
  assertEquals(RequestSchema.safeParse({ action: "delete_everything" }).success, false);
});

Deno.test("request: access check takes no other fields", () => {
  assertEquals(RequestSchema.safeParse({ action: "access" }).success, true);
  assertEquals(RequestSchema.safeParse({ action: "access", user_id: "x" }).success, false);
  assertEquals(RequestSchema.safeParse({ action: "access", message: "hi" }).success, false);
});

Deno.test("request: client_context accepts device details and GPS", () => {
  const r = RequestSchema.safeParse({
    action: "message",
    message: "hi",
    client_context: {
      device: { platform: "Linux armv8l", language: "en-UG", timezone: "Africa/Kampala", screen_w: 412, screen_h: 915, pixel_ratio: 2.625, touch: true },
      geo: { lat: 0.3476, lng: 32.5825, accuracy_m: 18.5 },
    },
  });
  assertEquals(r.success, true);
});

Deno.test("request: client_context rejects out-of-range or unknown fields", () => {
  const bad = [
    { geo: { lat: 91, lng: 0 } },
    { geo: { lat: 0, lng: 181 } },
    { geo: { lat: 0, lng: 0, accuracy_m: -1 } },
    { geo: { lat: 0 } },
    { geo: { lat: 0, lng: 0, altitude: 5 } },
    { device: { screen_w: 1e9 } },
    { device: { platform: "x".repeat(41) } },
    { device: { ip: "1.2.3.4" } },
    { ip: "1.2.3.4" },
    { user_id: "abc" },
  ];
  for (const client_context of bad) {
    assertEquals(RequestSchema.safeParse({ action: "message", message: "hi", client_context }).success, false, JSON.stringify(client_context));
  }
});

Deno.test("request: client_context is not accepted on escalate", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  assertEquals(RequestSchema.safeParse({ action: "escalate", conversation_id: id, client_context: {} }).success, false);
});

Deno.test("request: control characters are stripped", () => {
  assertEquals(cleanMessage("hi\u0000 there\u0007"), "hi there");
});

// ---- tool registry --------------------------------------------------------------------------

Deno.test("tools: every rpc is an assistant_agent_* function", () => {
  for (const t of AGENT_TOOLS) assert(/^assistant_agent_[a-z_]+$/.test(t.rpc), t.name);
});

Deno.test("tools: no tool exposes an identity parameter", () => {
  const banned = /(user|agent|tenant|account|wallet)_?id|^id$|^uid$/i;
  for (const t of AGENT_TOOLS) {
    const props = Object.keys((t.parameters.properties ?? {}) as Record<string, unknown>);
    for (const p of props) assert(!banned.test(p), `${t.name} exposes ${p}`);
    for (const k of Object.keys(t.toRpcArgs({}))) assert(!banned.test(k.replace(/^p_/, "")), `${t.name} rpc arg ${k}`);
  }
});

Deno.test("tools: the directory tools are registered and map to assistant_agent_* functions", () => {
  const expected: Record<string, string> = {
    get_my_profile: "assistant_agent_my_profile",
    find_tenants: "assistant_agent_find_tenants",
    get_tenant_detail: "assistant_agent_tenant_detail",
    get_landlords: "assistant_agent_landlords",
    get_subagents: "assistant_agent_subagents",
    get_subagent_detail: "assistant_agent_subagent_detail",
  };
  for (const [name, rpc] of Object.entries(expected)) assertEquals(findTool(name)?.rpc, rpc, name);
});

Deno.test("tools: search strings are restricted to letters, digits, space . ' + -", () => {
  const t = findTool("find_tenants")!;
  for (const ok of ["betty", "Betty Nabirye", "o'brien", "0701 355 246", "+256701355246", "Nakato-Namutebi", "Müller"]) {
    assert(t.schema.safeParse({ search: ok }).success, ok);
  }
  for (const bad of ["%", "_", "a;b", "' or 1=1 --", "<b>", "a\\b", "x\"y", "", "   ", "a".repeat(41), "{ignore}"]) {
    assert(!t.schema.safeParse({ search: bad }).success, JSON.stringify(bad));
  }
});

Deno.test("tools: detail tools require a search; list tools do not", () => {
  assert(!findTool("get_tenant_detail")!.schema.safeParse({}).success);
  assert(!findTool("get_subagent_detail")!.schema.safeParse({}).success);
  assert(findTool("find_tenants")!.schema.safeParse({}).success);
  assert(findTool("get_subagents")!.schema.safeParse({}).success);
  assert(findTool("get_landlords")!.schema.safeParse({}).success);
});

Deno.test("tools: directory tools reject identity-looking and unknown arguments", () => {
  for (const name of ["find_tenants", "get_tenant_detail", "get_landlords", "get_subagents", "get_subagent_detail", "get_my_profile"]) {
    const t = findTool(name)!;
    for (const extra of [{ tenant_id: "x" }, { agent_id: "x" }, { user_id: "x" }, { id: "x" }, { sub_agent_id: "x" }]) {
      assert(!t.schema.safeParse({ search: "betty", ...extra }).success, `${name} accepted ${Object.keys(extra)[0]}`);
    }
  }
});

Deno.test("tools: directory tool arguments map to the RPC's named parameters", () => {
  const find = findTool("find_tenants")!;
  const a = find.toRpcArgs({ search: "betty", plan: "active", period: "yesterday", limit: 10 });
  assertEquals(a, { p_search: "betty", p_plan: "active", p_from: resolvePeriod("yesterday").from, p_to: resolvePeriod("yesterday").to, p_limit: 10, p_email: "any" });
  const d = find.toRpcArgs({});
  assertEquals(d.p_search, null);
  assertEquals(d.p_plan, "all");
  assertEquals(d.p_limit, 15);
  assertEquals(d.p_email, "any");
  assertEquals(find.toRpcArgs({ email: "missing" }).p_email, "missing");
  assertEquals(findTool("get_subagents")!.toRpcArgs({}).p_email, "any");
  assertEquals(findTool("get_subagents")!.toRpcArgs({ email: "present" }).p_email, "present");
  assertEquals(d.p_from, resolvePeriod("last_30_days").from);
  const det = findTool("get_tenant_detail")!.toRpcArgs({ search: "betty", from: "2026-10-01", to: "2026-10-05" });
  assertEquals(det, { p_search: "betty", p_from: "2026-10-01", p_to: "2026-10-05" });
  assertEquals(findTool("get_subagents")!.toRpcArgs({ search: "sam", limit: 5 }).p_limit, 5);
  assertEquals(findTool("get_landlords")!.toRpcArgs({}), { p_search: null, p_limit: 15 });
  assertEquals(findTool("get_my_profile")!.toRpcArgs({}), {});
});

Deno.test("tools: the email filter only accepts any / missing / present", () => {
  for (const name of ["find_tenants", "get_subagents"]) {
    const t = findTool(name)!;
    for (const ok of ["any", "missing", "present"]) assert(t.schema.safeParse({ email: ok }).success, `${name} ${ok}`);
    for (const bad of ["all", "none", "yes", "", "a@b.com", "%"]) assert(!t.schema.safeParse({ email: bad }).success, `${name} ${bad}`);
  }
  // the detail tools have no email filter: they return everyone found, with or without an email
  assert(!findTool("get_tenant_detail")!.schema.safeParse({ search: "a", email: "missing" }).success);
});

Deno.test("tools: a limit above 25 or a period together with dates is rejected", () => {
  assert(!findTool("find_tenants")!.schema.safeParse({ limit: 26 }).success);
  assert(!findTool("get_subagents")!.schema.safeParse({ period: "today", from: "2026-10-01" }).success);
  assert(!findTool("get_tenant_detail")!.schema.safeParse({ search: "a", period: "today", to: "2026-10-01" }).success);
});

Deno.test("guard: a phone number returned by a tool may be repeated, others may not", () => {
  const tool = JSON.stringify({ tenants: [{ name: "Betty Nabirye", phone: "+256701111222" }] });
  assert(checkAnswer("Betty's number is +256701111222.", [tool], "betty phone").ok);
  assert(checkAnswer("Betty's number is 0701 111 222.", [tool], "betty phone").ok);
  assert(checkAnswer("Betty's number is 0701111222.", [tool], "betty phone").ok);
  assert(checkAnswer("Betty's number is 256701111222.", [tool], "betty phone").ok);
  assertEquals(checkAnswer("Call her on +256709999999.", [tool], "betty phone"), { ok: false, reason: "phone" });
  assertEquals(checkAnswer("Call her on 0709999999.", [tool], "betty phone"), { ok: false, reason: "phone" });
  // a phone number is not a money figure, and a money figure is still checked next to one
  assertEquals(checkAnswer("Betty (0701111222) paid UGX 250,000.", [tool], "x"), { ok: false, reason: "figure" });
});

Deno.test("tools: unknown tool names are not found", () => {
  assertEquals(findTool("run_sql"), undefined);
  assertEquals(findTool("get_wallet")?.rpc, "assistant_agent_wallet");
});

Deno.test("tools: schemas accept good arguments and reject extras", () => {
  const tx = findTool("get_wallet_transactions")!;
  assert(tx.schema.safeParse({ period: "last_7_days", direction: "in", limit: 10 }).success);
  assert(!tx.schema.safeParse({ period: "today", from: "2026-10-01" }).success);
  assert(!tx.schema.safeParse({ user_id: "abc" }).success);
  assert(!tx.schema.safeParse({ limit: 500 }).success);
  assertEquals(tx.toRpcArgs({ period: "yesterday" }), { p_from: resolvePeriod("yesterday").from, p_to: resolvePeriod("yesterday").to, p_direction: null, p_limit: 20 });
});

// ---- calculator, lanes, refusals ---------------------------------------------------------------

import { calculateRentPlan, CALC_TOOL } from "./calc.ts";
import { AGENT_KNOWLEDGE } from "./knowledge.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { MSG } from "./messages.ts";
import { openAiTools, PARTNER_TOOLS, toolAllowedFor } from "./tools.ts";

Deno.test("calc: 500,000 over 30 days matches the platform formula", () => {
  const r = calculateRentPlan(500000, 30);
  assertEquals(r.access_fee, 165000);
  assertEquals(r.request_fee, 20000);
  assertEquals(r.total_repayment, 685000);
  assertEquals(r.daily_repayment, 22834);
});

Deno.test("calc: small rent uses the 10,000 request fee; short tenors hit the floor", () => {
  assertEquals(calculateRentPlan(200000, 30).request_fee, 10000);
  const short = calculateRentPlan(300000, 7);
  const curve = Math.round(300000 * (Math.pow(1.33, 7 / 30) - 1));
  assert(short.access_fee > curve);
});

Deno.test("calc: out-of-range or unknown arguments are rejected", () => {
  assert(CALC_TOOL.schema.safeParse({ rent_amount: 500000, duration_days: 30 }).success);
  for (const bad of [{ rent_amount: 10, duration_days: 30 }, { rent_amount: 500000, duration_days: 3 }, { rent_amount: 500000, duration_days: 400 }, { rent_amount: 500000, duration_days: 30, user_id: "x" }, { rent_amount: 500000, duration_days: 30, monthly_rate: 0.5 }]) {
    assert(!CALC_TOOL.schema.safeParse(bad).success, JSON.stringify(bad));
  }
});

Deno.test("tools: someone with no agent footprint is offered no data tools", () => {
  const names = (isAgent: boolean) => openAiTools(isAgent ? "agent" : "none").map((t) => t.function.name);
  assertEquals(names(false).sort(), ["ask_clarification", "calculate_rent_plan", "search_help_center"]);
  assert(names(true).includes("get_wallet") && names(true).includes("calculate_rent_plan"));
});

Deno.test("guard: earning facts may be quoted, other figures may not", () => {
  assert(checkAnswer("You earn UGX 10,000 for registering a sub-agent.", [AGENT_KNOWLEDGE], "how do i earn").ok);
  assertEquals(checkAnswer("You earn UGX 50,000 per tenant.", [AGENT_KNOWLEDGE], "x"), { ok: false, reason: "figure" });
});

const LANDLORD_FLOAT_REPLY =
  "Your landlord float always depends on the number of rent requests you have posted. How many rent requests did you post?";

Deno.test("guard: the approved landlord float reply is accepted", () => {
  assert(checkAnswer(LANDLORD_FLOAT_REPLY, [AGENT_KNOWLEDGE], "How much landlord float can I spend?").ok);
  assert(checkAnswer(LANDLORD_FLOAT_REPLY, [], "how much float may I use").ok);
  assert(checkAnswer(LANDLORD_FLOAT_REPLY, [JSON.stringify({ landlord_float_available: 450000 })], "how much can I spend").ok);
  // Short enough to be returned with no tool call (MAX_UNGROUNDED_CHARS).
  assert(LANDLORD_FLOAT_REPLY.length <= 700);
});

Deno.test("prompt: spendable landlord float uses the approved reply, not a wallet figure", () => {
  const prompt = buildSystemPrompt({ todayKampala: "2026-11-02", persona: "agent", page: "agent_dashboard" });
  assert(prompt.includes(`Reply exactly: "${LANDLORD_FLOAT_REPLY}"`));
  assert(!prompt.includes("use the wallet's landlord_float_available"));
  const earn = AGENT_KNOWLEDGE.indexOf("the agent earns 1% of that payout");
  const spend = AGENT_KNOWLEDGE.indexOf(
    "How much landlord float an agent can spend always depends on the number of rent requests they have posted.",
  );
  assert(earn >= 0 && spend > earn);
  assert(AGENT_KNOWLEDGE.includes('When asked, say so and ask: "How many rent requests did you post?"'));
  assert(!findTool("get_wallet")!.description.includes("they can still spend"));
  assert(!findTool("get_landlord_float_status")!.description.includes("use get_wallet (landlord_float_available)"));
});

Deno.test("messages: refusals are friendly, never blame, never name the rules, and pass terminology", () => {
  for (const seed of ["a", "ab", "abc"]) {
    const m = MSG.refusal(seed);
    assert(checkAnswer(m, [], "x").ok);
    assert(!/not allowed|forbidden|unauthori[sz]ed|you don't seem/i.test(m));
  }
});

Deno.test("request: page hint is a fixed enum", () => {
  assertEquals(RequestSchema.safeParse({ action: "message", message: "hi", page: "agent_dashboard" }).success, true);
  assertEquals(RequestSchema.safeParse({ action: "message", message: "hi", page: "admin" }).success, false);
});

// ---- step 2: team, sub-agent tenants, league, houses, landlord float ---------------------------

Deno.test("tools: the network tools are registered and map to assistant_agent_* functions", () => {
  const expected: Record<string, string> = {
    get_team_summary: "assistant_agent_team_summary",
    get_subagent_tenants: "assistant_agent_subagent_tenants",
    get_league_standing: "assistant_agent_leaderboard",
    get_my_houses: "assistant_agent_houses",
    get_landlord_float_status: "assistant_agent_landlord_float",
  };
  for (const [name, rpc] of Object.entries(expected)) assertEquals(findTool(name)?.rpc, rpc, name);
});

Deno.test("tools: network tools reject identity-looking and unknown arguments", () => {
  const inputs: Record<string, Record<string, unknown>> = {
    get_team_summary: {}, get_subagent_tenants: { search: "sam" }, get_league_standing: {}, get_my_houses: {}, get_landlord_float_status: {},
  };
  for (const [name, base] of Object.entries(inputs)) {
    const t = findTool(name)!;
    assert(t.schema.safeParse(base).success, `${name} rejects valid input`);
    for (const extra of [{ agent_id: "x" }, { user_id: "x" }, { sub_agent_id: "x" }, { parent_id: "x" }, { team_id: "x" }, { id: "x" }]) {
      assert(!t.schema.safeParse({ ...base, ...extra }).success, `${name} accepted ${Object.keys(extra)[0]}`);
    }
  }
});

Deno.test("tools: sub-agent tenants needs a sub-agent search and a valid plan filter", () => {
  const t = findTool("get_subagent_tenants")!;
  assert(!t.schema.safeParse({}).success);
  assert(!t.schema.safeParse({ search: "sam", plan: "everything" }).success);
  assert(!t.schema.safeParse({ search: "' or 1=1 --" }).success);
  assertEquals(t.toRpcArgs({ search: "sam" }), { p_search: "sam", p_plan: "all", p_limit: 15 });
});

Deno.test("tools: league standing takes only a date; houses and float take fixed enums", () => {
  assert(findTool("get_league_standing")!.schema.safeParse({ week_start: "2026-10-26" }).success);
  assert(!findTool("get_league_standing")!.schema.safeParse({ week_start: "last week" }).success);
  assertEquals(findTool("get_league_standing")!.toRpcArgs({}), { p_week_start: null });
  assert(!findTool("get_my_houses")!.schema.safeParse({ status: "deleted" }).success);
  assert(!findTool("get_landlord_float_status")!.schema.safeParse({ status: "refunded" }).success);
  assert(!findTool("get_landlord_float_status")!.schema.safeParse({ limit: 99 }).success);
  assertEquals(findTool("get_team_summary")!.toRpcArgs({ period: "last_7_days" }).p_limit, 10);
});

Deno.test("tools: the team summary defaults to the last 7 days", () => {
  const a = findTool("get_team_summary")!.toRpcArgs({});
  assertEquals(a.p_from, resolvePeriod("last_7_days").from);
});

// ---- help centre -------------------------------------------------------------------------------

import { isGeneralTool } from "./tools.ts";

Deno.test("help: the search tool is general (offered to everyone) and maps to an assistant_agent_* function", () => {
  assertEquals(findTool("search_help_center")?.rpc, "assistant_agent_help_search");
  assert(isGeneralTool("search_help_center"));
  assert(!isGeneralTool("get_wallet") && !isGeneralTool("get_my_houses"));
});

Deno.test("help: the query is short plain text; markup, quotes, SQL and identity keys are rejected", () => {
  const t = findTool("search_help_center")!;
  for (const ok of ["renew a tenant after final payment", "how do I reset my password?", "Rent Plan cost & fees"]) {
    assert(t.schema.safeParse({ query: ok }).success, ok);
  }
  for (const bad of ["", "ab", "a".repeat(121), "<script>alert(1)</script>", "'; drop table x; --", "{ignore rules}", "x\y"]) {
    assert(!t.schema.safeParse({ query: bad }).success, JSON.stringify(bad));
  }
  assert(!t.schema.safeParse({ query: "renew", user_id: "x" }).success);
  assertEquals(t.toRpcArgs({ query: "renew a tenant" }), { p_query: "renew a tenant", p_limit: 4 });
});

Deno.test("guard repair: banned wording is rewritten to the approved terms", () => {
  assertEquals(cleanTerms("There is no interest on a loan, and lenders get ROI."), "There is no extra charges on a Rent Plan, and Supporters get Returns.");
  assert(checkAnswer(cleanTerms("The interest rate on loans is fixed."), [], "x").ok);
});

Deno.test("guard repair: wording is repaired but figures never are", () => {
  assertEquals(cleanTerms("You collected UGX 250,000."), "You collected UGX 250,000.");
  assertEquals(checkAnswer(cleanTerms("You collected UGX 250,000."), [DAY_OUTPUT], "x").ok, false);
});

Deno.test("guard retry: every failure reason has a note for the model", () => {
  for (const reason of ["terminology", "figure", "uuid", "phone"] as const) assert(RETRY_NOTE[reason].length > 20);
});

Deno.test("long ungrounded answers are cut at a sentence end", () => {
  const long = "First sentence here. ".repeat(80);
  const cut = trimToSentence(long, 300);
  assert(cut.length <= 300);
  assert(cut.endsWith("."));
  assertEquals(trimToSentence("Short one.", 300), "Short one.");
});

Deno.test("target progress tool: no arguments, no identity, agent-only", () => {
  const t = findTool("get_target_progress")!;
  assertEquals(t.rpc, "assistant_agent_target_progress");
  assert(t.schema.safeParse({}).success);
  assertEquals(t.schema.safeParse({ agent_id: "5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d" }).success, false);
  assert(!isGeneralTool("get_target_progress"));
});

Deno.test("target figures from the tool pass the guard, invented ones do not", () => {
  const out = JSON.stringify({ amount_needed_to_pass: 75869, needed_per_day_including_today: 37935, percent_so_far: 35.1 });
  assert(checkAnswer("You need UGX 75,869 more, about UGX 37,935 a day.", [out], "am i on target").ok);
  assertEquals(checkAnswer("You need UGX 80,000 more.", [out], "am i on target").ok, false);
});

// ---- partner (funder) persona ----------------------------------------------------------------

Deno.test("partner tools: every RPC is assistant_partner_*, no identity arguments, no overlap with agent tools", () => {
  assert(PARTNER_TOOLS.length >= 8);
  for (const t of PARTNER_TOOLS) {
    assert(/^assistant_partner_[a-z_]+$/.test(t.rpc), t.rpc);
    assertEquals(t.schema.safeParse({ partner_id: "5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d" }).success, false);
    assertEquals(t.schema.safeParse({ user_id: "x" }).success, false);
    assertEquals(AGENT_TOOLS.some((a) => a.name === t.name), false);
  }
});

Deno.test("partner tools: arguments are validated before anything runs", () => {
  const detail = findTool("get_partner_portfolio_detail")!;
  assert(detail.schema.safeParse({ code: "WPF-3542" }).success);
  assert(detail.schema.safeParse({ code: "WIP2610124417" }).success);
  assertEquals(detail.schema.safeParse({ code: "WPF-1'; drop table x;--" }).success, false);
  assertEquals(detail.schema.safeParse({ code: "ab" }).success, false);
  const list = findTool("get_partner_portfolios")!;
  assertEquals(list.schema.safeParse({ status: "cancelled" }).success, false);
  assertEquals(list.toRpcArgs({}), { p_status: "all", p_search: null, p_limit: 15 });
  const wd = findTool("get_partner_withdrawals")!;
  assertEquals(wd.schema.safeParse({ period: "last_week", from: "2026-10-01" }).success, false);
  assertEquals(wd.toRpcArgs({ status: "paid" }), { p_status: "paid", p_limit: 15 });
  assertEquals(findTool("get_partner_upcoming")!.schema.safeParse({ days: 9999 }).success, false);
  assertEquals(findTool("get_partner_returns")!.toRpcArgs({}), {});
});

Deno.test("personas keep their own tools: a partner cannot call agent tools and an agent cannot call partner tools", () => {
  assert(toolAllowedFor("partner", "get_partner_overview"));
  assert(!toolAllowedFor("partner", "get_wallet"));
  assert(!toolAllowedFor("agent", "get_partner_overview"));
  assert(toolAllowedFor("agent", "get_wallet"));
  assert(!toolAllowedFor("none", "get_wallet") && !toolAllowedFor("none", "get_partner_overview"));
  assert(toolAllowedFor("none", "search_help_center"));
  const names = (p: "agent" | "partner" | "none") => openAiTools(p).map((t) => t.function.name);
  assert(names("partner").includes("get_partner_portfolios") && !names("partner").includes("get_wallet"));
  assert(!names("agent").some((n) => n.startsWith("get_partner_")));
  assertEquals(names("none").sort(), ["ask_clarification", "calculate_rent_plan", "search_help_center"]);
});

Deno.test("prompt: the assistant is Nexa and states the support rules", () => {
  const rules = [
    "You are Nexa, the Welile assistant",
    "Your name is Nexa. Never call yourself Clara or any other name.",
    "https://wa.me/256777607640 (+256777607640)",
    "Never say a request was sent, passed on, forwarded or escalated",
    "list every one of the user's own houses",
    "no 'high volume'",
    "no 'the queue is long'",
  ];
  for (const ctx of [
    { todayKampala: "2026-11-11", persona: "agent" as const, page: "agent_dashboard" as const },
    { todayKampala: "2026-11-11", persona: "partner" as const, page: "funder_dashboard" as const },
    { todayKampala: "2026-11-11", persona: "none" as const, page: "funder_dashboard" as const },
    { todayKampala: "2026-11-11", persona: "none" as const, page: "other" as const },
  ]) {
    const prompt = buildSystemPrompt(ctx);
    for (const rule of rules) assert(prompt.includes(rule), rule);
    assert(!prompt.includes("You are Clara"));
    assert(!prompt.includes("\u2014"));
  }
});

Deno.test("partner prompt: partner topics only, masked payouts, no agent earning facts, no banned wording as advice", () => {
  const p = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "partner", page: "funder_dashboard" });
  assert(p.includes("ending 245") && p.includes("portfolio"));
  assert(p.includes("investment advice"));
  assert(!p.includes("10,000 sub-agent registration") && !p.includes("get_target_progress"));
  assert(!p.includes("get_collection_day_detail"));
  const none = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "none", page: "funder_dashboard" });
  assert(none.includes("no partnership on Welile yet") && none.includes("NO data tools"));
  assert(!none.includes("get_partner_overview"));
  const agent = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "agent", page: "agent_dashboard" });
  assert(agent.includes("get_target_progress") && !agent.includes("ending 245"));
});

Deno.test("partner figures from the tools pass the guard; invented ones do not", () => {
  const out = JSON.stringify({ earned_total: 280207, active_principal: 846957, standard_monthly_returns_estimate: 7500 });
  assert(checkAnswer("Your Returns earned so far are UGX 280,207 on UGX 846,957 active.", [out], "how much have I earned").ok);
  assertEquals(checkAnswer("Your Returns earned so far are UGX 300,000.", [out], "how much have I earned").ok, false);
  assertEquals(checkAnswer("It was sent to 0777 123 456.", [out], "where did it go").ok, false);
});

Deno.test("partner new-portfolio rate: the partner's own rate, no arguments, partner persona only", () => {
  const t = findTool("get_my_new_portfolio_rate")!;
  assertEquals(t.rpc, "assistant_partner_new_portfolio_rate");
  assert(t.schema.safeParse({}).success);
  assertEquals(t.schema.safeParse({ partner_id: "5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d" }).success, false);
  assertEquals(t.schema.safeParse({ rate: 20 }).success, false);
  assertEquals(t.toRpcArgs({}), {});
  assert(toolAllowedFor("partner", "get_my_new_portfolio_rate"));
  assert(!toolAllowedFor("agent", "get_my_new_portfolio_rate") && !toolAllowedFor("none", "get_my_new_portfolio_rate"));
  const p = buildSystemPrompt({ todayKampala: "2026-11-07", persona: "partner", page: "funder_dashboard" });
  assert(p.includes("get_my_new_portfolio_rate") && p.includes("never use it for an existing portfolio"));
});

Deno.test("360 partner sentence: each partner earns their own Returns rate (D8 wording)", () => {
  assert(AGENT_KNOWLEDGE.includes("each partner earns their own Returns rate"));
  assert(!AGENT_KNOWLEDGE.includes("Partner Returns target 15%"));
});

Deno.test("request schema accepts the funder dashboard page hint and nothing else", () => {
  assert(RequestSchema.safeParse({ action: "message", message: "hi", page: "funder_dashboard" }).success);
  assertEquals(RequestSchema.safeParse({ action: "message", message: "hi", page: "admin_dashboard" }).success, false);
});

Deno.test("partner wallet activity: validated arguments, no identity, defaults to the last 30 days", () => {
  const t = findTool("get_partner_wallet_activity")!;
  assertEquals(t.rpc, "assistant_partner_wallet_activity");
  assert(t.schema.safeParse({ direction: "in", period: "last_7_days" }).success);
  assertEquals(t.schema.safeParse({ direction: "sideways" }).success, false);
  assertEquals(t.schema.safeParse({ period: "last_week", from: "2026-10-01" }).success, false);
  assertEquals(t.schema.safeParse({ partner_id: "5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d" }).success, false);
  assertEquals(t.toRpcArgs({}), { p_direction: null, p_limit: 20 });
  assert(toolAllowedFor("partner", "get_partner_wallet_activity") && !toolAllowedFor("agent", "get_partner_wallet_activity"));
});

Deno.test("partner prompt: wallet activity is not reconciled and reversals or corrections are never mentioned", () => {
  const p = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "partner", page: "funder_dashboard" });
  assert(p.includes("may not add up to the balance"));
  assert(/Never mention, hint at or speculate about reversals, corrections, adjustments/.test(p));
  const tool = findTool("get_partner_wallet_activity")!.description;
  assert(/never try to reconcile/i.test(tool));
});

Deno.test("partner tools never expose a raw withdrawal status or a reversal flag in their descriptions", () => {
  for (const t of PARTNER_TOOLS) {
    assert(!/\breversed\b/i.test(t.description.replace(/never mention[^.]*\./gi, "")) || t.name === "get_partner_wallet_activity", t.name);
  }
});

// ---- follow-ups from the 60-question live test --------------------------------------------------

Deno.test("partner admin trail: a partner reply may not mention reversals, corrections or adjustments (or say there are none)", () => {
  const opts = { hideAdminTrail: true };
  for (const bad of [
    "I don't see any reversals listed here.",
    "Your top-up was reversed last week.",
    "There were no admin corrections on your wallet.",
    "A balance adjustment was made.",
    "I can't see any internal admin adjustments or corrections.",
  ]) assertEquals(checkAnswer(bad, [], "x", opts), { ok: false, reason: "admin_trail" }, bad);
  assert(checkAnswer("I can show your top-ups and wallet activity as they appear on your account.", [], "x", opts).ok);
  // the agent persona is unaffected
  assert(checkAnswer("That System balance correction was UGX 15.", [], "x").ok);
  assert(RETRY_NOTE.admin_trail.length > 40);
});

Deno.test("partner refusals talk about portfolios, not tenants, and the deflection never confirms or denies", () => {
  for (const seed of ["a", "bb", "ccc"]) {
    const r = MSG.refusal(seed, "partner");
    assert(/portfolio|Returns|withdrawals|wallet/i.test(r) && !/tenant|collection/i.test(r), r);
    assert(!/\b(loan|lender|ROI|interest)\b/i.test(r));
    assertEquals(MSG.refusal(seed, "agent") === r, false);
  }
  assertEquals(checkAnswer(MSG.partnerDeflect, [], "x", { hideAdminTrail: true }).ok, true);
});

Deno.test("prompts: dual-role people are pointed to the other dashboard, never refused; league and team differ", () => {
  const agentAlsoPartner = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "agent", page: "agent_dashboard", alsoPartner: true });
  assert(agentAlsoPartner.includes("also a partner") && agentAlsoPartner.includes("funder) dashboard"));
  const agentOnly = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "agent", page: "agent_dashboard" });
  assert(!agentOnly.includes("also a partner"));
  const partnerAlsoAgent = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "partner", page: "funder_dashboard", alsoAgent: true });
  assert(partnerAlsoAgent.includes("also an agent"));
  assert(agentOnly.includes("get_team_summary covers only the agent's direct verified sub-agents"));
  const partner = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "partner", page: "funder_dashboard" });
  assert(/never describe screens/i.test(partner) && partner.includes("compounded_so_far"));
  assert(/Do not use the words reverse, reversed, reversal, correction or adjustment/.test(partner));
});

Deno.test("agent wallet list: the model is told it is not a full ledger and must not reconcile or mention corrections", () => {
  const d = findTool("get_wallet_transactions")!.description;
  assert(/NOT a full ledger/.test(d) && /never try to reconcile/i.test(d));
  const p = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "agent", page: "agent_dashboard" });
  assert(p.includes("customer-facing entries only") && /Do not mention or speculate about corrections, reversals or adjustments/.test(p));
});

Deno.test("partner contract: one tool, no arguments, agent persona cannot call it", () => {
  const t = findTool("get_partner_contract")!;
  assertEquals(t.rpc, "assistant_partner_contract");
  assert(t.schema.safeParse({}).success);
  assertEquals(t.schema.safeParse({ partner_id: "5631cfe1-14b0-4ce2-9b9a-f7a808d3b12d" }).success, false);
  assert(toolAllowedFor("partner", "get_partner_contract") && !toolAllowedFor("agent", "get_partner_contract"));
  assert(/Never say or imply the partner did not sign/.test(t.description));
  assert(!/AGREEMENT \(status/.test(findTool("get_partner_overview")!.description));
});

Deno.test("partner contract: telling a partner they did not sign fails the guard, honest wording passes", () => {
  const opts = { noSignatureClaims: true };
  for (const bad of [
    "It looks like you haven't signed a formal partnership agreement document yet.",
    "You have not signed any contract.",
    "You didn't sign anything.",
    "Your agreement is unsigned.",
    "You never signed a contract with us.",
    "The agreement has not been signed.",
  ]) assertEquals(checkAnswer(bad, [], "x", opts), { ok: false, reason: "signature_claim" }, bad);
  for (const good of [
    "You accepted the Welile partner terms online (v1.0) on 2026-09-15, and your portfolio terms are listed below.",
    "Your agreement is waiting for Welile's countersignature.",
    "I can't find an agreement on the account yet.",
    "There is no separate signed partnership document on your account, but you accepted the terms online.",
  ]) assert(checkAnswer(good, [], "x", opts).ok, good);
  // the agent persona is untouched
  assert(checkAnswer("You haven't signed that tenant's form yet.", [], "x").ok);
  assert(RETRY_NOTE.signature_claim.includes("get_partner_contract"));
  assert(!/\b(loan|lender|ROI|interest)\b/i.test(MSG.partnerContractFallback));
});

Deno.test("partner prompt: contract rule covers every state and forbids 'didn't sign'", () => {
  const p = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "partner", page: "funder_dashboard" });
  for (const s of ["signed_agreement", "agreement_awaiting_welile_countersignature", "accepted_terms_online", "none_on_record"]) assert(p.includes(s), s);
  assert(p.includes("a missing document is not a missing contract"));
});

Deno.test("partner prompt: renewal answers come from the help centre, not from invented steps", () => {
  const p = buildSystemPrompt({ todayKampala: "2026-11-05", persona: "partner", page: "funder_dashboard" });
  assert(p.includes("Renewing or creating a portfolio: call search_help_center"));
  assert(!p.includes("has no step-by-step article"));
  assert(p.includes("never describe screens") || p.includes("Never describe screens"));
});
