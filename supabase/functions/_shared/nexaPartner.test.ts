import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { estimateSupporterReturns, runNexaTool } from "./nexaTools.ts";
import { isStaff, knowledgeScopesFor, filterKnowledgeForAudience } from "./nexaAccess.ts";
import { buildNexaSystemPrompt, NEXA_NAME_AND_SUPPORT_RULES, NEXA_SALES_SYSTEM_PROMPT } from "./nexa.ts";
import { normalizePortfolioCode, requestPortfolioOtp, GENERIC_SENT } from "./nexaPortfolioAccess.ts";

// The new-partner rate is the live public rate passed in by the caller; no rate lives in the code.
Deno.test("a new partner gets the rate passed in (10% here), simple", () => {
  const r = estimateSupporterReturns({ amount: 1_000_000, months: 12 }, 10) as any;
  assertEquals(r.monthlyRatePercent, 10); assertEquals(r.totalReturns, 1_200_000);
  assertEquals(r.disclaimer, "New partners earn a 15% Rent profit share per month for 12 months. Your principal and Rent profit share are guaranteed as set out in your partnership agreement.");
  assert(!r.disclaimer.includes("Returns") && !r.disclaimer.includes("\u2014"));
});
Deno.test("switch off: the public rate 15 gives today's figures", () => {
  const r = estimateSupporterReturns({ amount: 1_000_000, months: 12 }, 15) as any;
  assertEquals(r.monthlyRatePercent, 15); assertEquals(r.totalReturns, 1_800_000);
});
Deno.test("compound at 10% matches 1.1^12", () => {
  const r = estimateSupporterReturns({ amount: 1_000_000, months: 12, mode: "compound" }, 10) as any;
  assert(Math.abs(r.endingBalance - 3_138_428) <= 12);
});
Deno.test("no rate known -> error, never a default figure", () => {
  const r = estimateSupporterReturns({ amount: 1_000_000, months: 12 }, null) as any;
  assert("error" in r && /not available/.test(r.error));
});
Deno.test("an existing portfolio's own 15% and 20% are honoured whatever the default", () => {
  assertEquals((estimateSupporterReturns({ amount: 100_000, months: 12, rate: 15 }, 10) as any).totalReturns, 180_000);
  assertEquals((estimateSupporterReturns({ amount: 100_000, months: 1, rate: 20 }, null) as any).totalReturns, 20_000);
});
Deno.test("bad inputs rejected", () => {
  assert("error" in estimateSupporterReturns({ amount: 100 }, 10));
  assert("error" in estimateSupporterReturns({ amount: 100_000, rate: 50 }, 10));
});
Deno.test("get_my_portfolios refuses without verified identity", async () => {
  const r = await runNexaTool("get_my_portfolios", "{}", null) as any;
  assert(r.error);
});
Deno.test("non-staff never get staff knowledge scopes", () => {
  for (const roles of [[], ["supporter"], ["tenant"], ["agent", "landlord"], ["pending", "send_push"]]) {
    assert(!isStaff(roles));
    const s = knowledgeScopesFor(roles);
    assert(!s.includes("staff") && !s.some(x => ["manager", "cfo", "ceo", "operations", "admin"].includes(x)), JSON.stringify(roles));
  }
  assert(isStaff(["manager"])); assert(knowledgeScopesFor(["manager"]).includes("staff"));
});
Deno.test("knowledge rows filtered by audience", () => {
  const rows = [{ role_scope: "all" }, { role_scope: "supporter" }, { role_scope: "staff" }, { role_scope: "cfo" }, { role_scope: null }];
  assertEquals(filterKnowledgeForAudience(rows, ["supporter"]).map(r => r.role_scope), ["all", "supporter"]);
  assertEquals(filterKnowledgeForAudience(rows, []).map(r => r.role_scope), ["all"]);
  assertEquals(filterKnowledgeForAudience(rows, ["cfo"]).map(r => r.role_scope), ["all", "staff", "cfo"]);
});
Deno.test("prompt: supporter section, firewall, tenant priority only for tenants/unknown", () => {
  const sup = buildNexaSystemPrompt(["supporter"], false);
  assert(sup.includes("verified Supporter")); assert(sup.includes("FIREWALL")); assert(!sup.includes("Priority #1: Tenant Support"));
  // No rate history and no fixed rate: the live public rate is passed in (none here -> no figure).
  assert(!sup.includes("20% per month") && !sup.includes("15% per month") && !sup.includes("10% per month"));
  assert(sup.includes("give no figures"));
  assert(buildNexaSystemPrompt(["supporter"], false, 15).includes("New partners earn a 15% Rent profit share per month for 12 months."));
  assert(!buildNexaSystemPrompt(["supporter"], false, 15).includes("illustrative, not guaranteed"));
  assert(buildNexaSystemPrompt([], false).includes("Priority #1: Tenant Support"));
  assert(buildNexaSystemPrompt(["tenant"], false).includes("Priority #1: Tenant Support"));
  assert(!buildNexaSystemPrompt(["manager"], true).includes("this caller is NOT Welile staff"));
});
Deno.test("no em-dashes in Nexa copy", () => {
  assert(!buildNexaSystemPrompt(["supporter"], false).includes("\u2014"));
  assert(!buildNexaSystemPrompt(["supporter"], false, 10).includes("\u2014"));
  assert(!NEXA_SALES_SYSTEM_PROMPT.includes("\u2014"));
  assert(!NEXA_NAME_AND_SUPPORT_RULES.includes("\u2014"));
  assert(!NEXA_NAME_AND_SUPPORT_RULES.includes("Returns"));
});
Deno.test("every Nexa system prompt carries the name and support rules", () => {
  for (const prompt of [
    NEXA_SALES_SYSTEM_PROMPT,
    buildNexaSystemPrompt([], false),
    buildNexaSystemPrompt(["supporter"], false, 15),
    buildNexaSystemPrompt(["agent"], false),
    buildNexaSystemPrompt(["manager"], true, 15),
  ]) {
    assert(prompt.includes(NEXA_NAME_AND_SUPPORT_RULES), prompt.slice(0, 80));
    assert(prompt.includes("Your name is Nexa. Never call yourself Clara or any other name."));
    assert(prompt.includes("https://wa.me/256777607640 (+256777607640)"));
    assert(prompt.includes("Never say a request was sent, passed on, forwarded or escalated"));
    assert(prompt.includes("list every one of the user's own houses"));
    assert(prompt.includes("no 'high volume'"));
  }
});
Deno.test("portfolio and returns questions reach the tool", async () => {
  const { isPortfolioOrReturnsQuestion } = await import("./nexaTools.ts");
  assert(isPortfolioOrReturnsQuestion("What is my portfolio balance?"));
  assert(isPortfolioOrReturnsQuestion("Supporting a tenant with UGX 100000"));
  assert(!isPortfolioOrReturnsQuestion("How do I deposit into my wallet?"));
});
Deno.test("portfolio code format", () => {
  assertEquals(normalizePortfolioCode(" wip2607247541 "), "WIP2607247541");
  assertEquals(normalizePortfolioCode("WPF-1234"), "WPF-1234");
  assertEquals(normalizePortfolioCode("1234"), null);
});
// Fake admin client: records inserts, returns no target, so we can check existence is not leaked.
function fakeAdmin(target: unknown) {
  const inserts: unknown[] = [];
  const chain: any = { select: () => chain, eq: () => chain, like: () => chain, gte: () => chain, gt: () => chain, limit: async () => ({ data: [] }),
    then: (res: any) => res({ count: 0, data: null }) };
  return { inserts, from: (_t: string) => ({ ...chain, insert: (row: unknown) => { inserts.push(row); return { select: () => ({ single: async () => ({ data: { id: crypto.randomUUID() }, error: null }) }) , then: (r: any) => r({}) }; } }),
    rpc: async () => ({ data: target }) };
}
Deno.test("OTP request gives the same answer for unknown and known codes", async () => {
  const unknown = await requestPortfolioOtp(fakeAdmin([]), "WIP0000000000", "1.1.1.1");
  const bad = await requestPortfolioOtp(fakeAdmin([]), "nonsense", "1.1.1.1");
  const known = await requestPortfolioOtp(fakeAdmin([{ portfolio_id: crypto.randomUUID(), investor_id: crypto.randomUUID(), phone: "+256700000000" }]), "WIP0000000001", "1.1.1.1");
  for (const r of [unknown, bad, known]) { assert(r.ok); assertEquals((r as any).message, GENERIC_SENT); assert(/^[0-9a-f-]{36}$/.test((r as any).challengeId)); }
});
Deno.test("denied portfolio tool and unknown tool raise alerts", async () => {
  const seen: string[] = [];
  await runNexaTool("get_my_portfolios", "{}", null, async (t) => { seen.push(t); });
  await runNexaTool("list_all_partners", "{}", null, async (t) => { seen.push(t); });
  await runNexaTool("estimate_supporter_returns", '{"amount":100000}', null, async (t) => { seen.push(t); });
  assertEquals(seen, ["get_my_portfolios", "list_all_partners"]);
});
Deno.test("OTP lockout after 3 wrong codes writes an alert", async () => {
  const { verifyPortfolioOtp } = await import("./nexaPortfolioAccess.ts");
  const inserted: Array<{ table: string; row: any }> = [];
  const ch = { id: crypto.randomUUID(), portfolio_id: crypto.randomUUID(), otp_hash: "x", expires_at: new Date(Date.now() + 60000).toISOString(), attempts: 2, consumed_at: null, locked_until: null };
  const admin: any = { from: (table: string) => {
    const c: any = { select: () => c, eq: () => c, is: () => c, maybeSingle: async () => ({ data: ch }), update: () => c, then: (r: any) => r({}),
      insert: async (row: any) => { inserted.push({ table, row }); return {}; } };
    return c; } };
  const r = await verifyPortfolioOtp(admin, ch.id, "123456", "1.1.1.1", { channel: "whatsapp", phone: "+256700000000" });
  assert(!r.ok);
  const alert = inserted.find(x => x.table === "nexa_access_alerts");
  assert(alert && alert.row.channel === "whatsapp" && alert.row.attempted_resource === "portfolio_otp_verify");
});
