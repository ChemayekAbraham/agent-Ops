// Partner Returns per person (Phase 4): Nexa quotes only the rate it is given (the live public
// new-partner rate), never a fixed one, and states no figure when it has none.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAccountPhoneAndDashboardGuideReply,
  buildFinancialAccessFallbackReply,
  buildNexaPublicGuideReply,
  buildPromissoryNoteReminderReply,
  buildWelileWalletGuideReply,
  newPartnerReturnsSentence,
  returnsExampleSentence,
} from "./nexaGuides.ts";
import { buildSignupPersuasionPitch } from "./nexaSignup.ts";
import { buildNexaToolDefs, estimateSupporterReturns, RATE_UNAVAILABLE_ERROR, runNexaTool } from "./nexaTools.ts";
import { buildNexaSystemPrompt, buildSupporterReturnsKnowledge, NEXA_SALES_SYSTEM_PROMPT } from "./nexa.ts";
import { monthlyReturnFor } from "./partnerReturnPolicy.ts";

const ugx = (n: number) => n.toLocaleString("en-US");

// Every guide builder, with and without a rate.
const guides = (rate: number | null): Record<string, string> => ({
  account: buildAccountPhoneAndDashboardGuideReply("", rate),
  wallet: buildWelileWalletGuideReply(rate),
  promissory: buildPromissoryNoteReminderReply(rate),
  supportTenant: buildNexaPublicGuideReply("I want to support a tenant", false, rate) ?? "",
  aboutWelile: buildNexaPublicGuideReply("what is welile", false, rate) ?? "",
  financial: buildFinancialAccessFallbackReply("financial inclusion", false, rate),
  pitch: buildSignupPersuasionPitch("supporter", false, rate),
});

const APPROVED = "New partners earn a 15% Rent profit share per month for 12 months. Your principal and Rent profit share are guaranteed as set out in your partnership agreement.";

Deno.test("guides: approved new-partner sentence, never the old Returns claim", () => {
  for (const rate of [15, 10, null]) for (const [name, text] of Object.entries(guides(rate))) {
    assert(text.includes(APPROVED), name);
    assert(!text.includes("illustrative Returns"), name);
    assert(!text.includes("UGX 7,000"), name);
    assert(!text.includes("10% per month"), name);
    assert(text.includes("Existing partners keep their own rate"), name);
  }
});

Deno.test("guides: no rate -> no worked UGX example", () => {
  for (const [name, text] of Object.entries(guides(null))) {
    assert(text.includes(APPROVED), name);
    assert(!/\d+(\.\d+)?% per month/.test(text), name);
    assert(!text.includes("UGX 100,000 illustrates"), name);
    assert(!/UGX [\d,]+\/month/.test(text), name);
    assert(!text.includes("  "), `${name}: double space where the example was dropped`);
  }
  // The default (no argument) is the same as null: fail closed.
  assertEquals(buildWelileWalletGuideReply(), buildWelileWalletGuideReply(null));
  assertEquals(buildPromissoryNoteReminderReply(), buildPromissoryNoteReminderReply(null));
  assertEquals(buildNexaPublicGuideReply("I want to support a tenant"), buildNexaPublicGuideReply("I want to support a tenant", false, null));
});

Deno.test("guides: the UGX 100,000 example equals monthlyReturnFor", () => {
  for (const rate of [10, 12.5, 15, 20]) {
    const m = monthlyReturnFor(100_000, rate)!;
    const s = returnsExampleSentence(rate);
    assert(s.includes(`UGX ${ugx(m)}/month`), s);
    assert(s.includes(`UGX ${ugx(m * 12)} over 12 months`), s);
    assert(buildSignupPersuasionPitch("supporter", false, rate).includes(`UGX ${ugx(m)}/month`));
  }
  assertEquals(returnsExampleSentence(null), "");
  assertEquals(returnsExampleSentence(0), "");
  assert(newPartnerReturnsSentence(12.5).includes(APPROVED));
  assert(!newPartnerReturnsSentence(12.5).includes("12.5%"));
});

Deno.test("knowledge(15): the approved sentence, the rule, computed examples; no history", () => {
  const k = buildSupporterReturnsKnowledge(15);
  assert(k.includes(APPROVED));
  assert(!k.includes("illustrative, not guaranteed"));
  assert(!k.includes("capital is at risk"));
  assert(k.includes("Existing partners keep the rate"));
  assert(!k.includes("20% per month") && !k.includes("15% per month") && !k.includes("10% per month"));
  assert(!k.includes("everyone joining now starts"), "old rate-history sentence");
  assert(!k.includes("Rate history"));
  assert(!k.includes("—"));
  // Examples equal the tool's own output.
  const big = estimateSupporterReturns({ amount: 1_000_000, months: 12 }, 15) as any;
  const bigC = estimateSupporterReturns({ amount: 1_000_000, months: 12, mode: "compound" }, 15) as any;
  const small = estimateSupporterReturns({ amount: 100_000, months: 12 }, 15) as any;
  const smallC = estimateSupporterReturns({ amount: 100_000, months: 12, mode: "compound" }, 15) as any;
  assertEquals(big.monthlyBreakdown[0].returns, monthlyReturnFor(1_000_000, 15));
  assertEquals(small.monthlyBreakdown[0].returns, monthlyReturnFor(100_000, 15));
  assert(k.includes(`Payout gives UGX ${ugx(big.monthlyBreakdown[0].returns)} a month, UGX ${ugx(big.totalReturns)} in total Returns`));
  assert(k.includes(`Compounding grows to about UGX ${ugx(bigC.endingBalance)}, about UGX ${ugx(bigC.totalReturns)} in Returns`));
  assert(k.includes(`Payout gives UGX ${ugx(small.monthlyBreakdown[0].returns)} a month, UGX ${ugx(small.totalReturns)} total`));
  assert(k.includes(`Compounding grows to about UGX ${ugx(smallC.endingBalance)}.`));
  assert(k.includes("quote only the worked examples"));
});

Deno.test("knowledge(10) and knowledge(null)", () => {
  assert(buildSupporterReturnsKnowledge(10).includes(APPROVED));
  assert(buildSupporterReturnsKnowledge(10).includes("Examples at 10%"));
  const none = buildSupporterReturnsKnowledge(null);
  const firstLine = none.split("\n")[1];
  assert(firstLine.startsWith("New partners earn a 15% Rent profit share"), firstLine);
  assert(none.includes("give no figures"));
  assert(!none.includes("Examples at"));
});

Deno.test("system prompt: approved sentence, no old per-month Returns rate phrasing", () => {
  assert(!/\b(10|15|20)% (per month|a month)/.test(NEXA_SALES_SYSTEM_PROMPT));
  assert(NEXA_SALES_SYSTEM_PROMPT.includes(APPROVED));
  assert(buildNexaSystemPrompt([], false, 15).includes(APPROVED));
  assert(buildNexaSystemPrompt([], false, null).includes("give no figures"));
  assert(!buildNexaSystemPrompt([], false, null).includes("no number is available right now"));
  assert(!buildNexaSystemPrompt([], false, null).includes("UGX 7,000"));
});

Deno.test("tool defs: own-rate tool only for a signed-in caller; estimate text follows the rate", () => {
  const anon = buildNexaToolDefs({ publicRate: 10, ownRate: false });
  assert(!anon.some((t) => t.function.name === "get_my_returns_rate"));
  assert(anon[0].function.description.includes("10% a month now"));
  const signedIn = buildNexaToolDefs({ publicRate: 15, ownRate: true });
  assert(signedIn.some((t) => t.function.name === "get_my_returns_rate"));
  const noRate = buildNexaToolDefs({ publicRate: null, ownRate: false });
  assert(noRate[0].function.description.includes("then give no figure"));
  assert(!/\d+%/.test(noRate[0].function.description));
});

Deno.test("runNexaTool: estimate uses ctx.defaultRate; own rate needs readMyRate", async () => {
  const est = await runNexaTool("estimate_supporter_returns", '{"amount":100000,"months":1}', null, undefined, { defaultRate: 10 }) as any;
  assertEquals(est.totalReturns, 10_000);
  const noRate = await runNexaTool("estimate_supporter_returns", '{"amount":100000}', null) as any;
  assert("error" in noRate);

  const denied: string[] = [];
  const r = await runNexaTool("get_my_returns_rate", "{}", null, async (t) => { denied.push(t); }) as any;
  assert(r.error && /Sign in/.test(r.error));
  assertEquals(denied, ["get_my_returns_rate"]);

  const mine = await runNexaTool("get_my_returns_rate", "{}", null, undefined, { defaultRate: 10, readMyRate: async () => ({ rate: 15 }) }) as any;
  assertEquals(mine, { rate: 15 });
});

Deno.test("runNexaTool: a signed-in caller's estimate without a rate uses their own new-portfolio rate", async () => {
  let reads = 0;
  const readMyRate = async () => { reads++; return { rate: 20 }; };
  const own = await runNexaTool("estimate_supporter_returns", '{"amount":100000,"months":1}', null, undefined, { defaultRate: 10, readMyRate }) as any;
  assertEquals([own.monthlyRatePercent, own.totalReturns, reads], [20, 20_000, 1]);
  // An empty rate counts as omitted.
  const blank = await runNexaTool("estimate_supporter_returns", '{"amount":100000,"months":1,"rate":""}', null, undefined, { defaultRate: 10, readMyRate }) as any;
  assertEquals([blank.monthlyRatePercent, reads], [20, 2]);
  // An explicit rate (a hypothetical new partner, or an existing portfolio) wins and reads nothing.
  const explicit = await runNexaTool("estimate_supporter_returns", '{"amount":100000,"months":1,"rate":10}', null, undefined, { defaultRate: 10, readMyRate }) as any;
  assertEquals([explicit.monthlyRatePercent, explicit.totalReturns, reads], [10, 10_000, 2]);
});

Deno.test("runNexaTool: a signed-in caller whose rate cannot be read gets no figure (never the public rate)", async () => {
  const r = await runNexaTool("estimate_supporter_returns", '{"amount":100000}', null, undefined, {
    defaultRate: 10,
    readMyRate: async () => ({ error: "Your rate is unavailable right now." }),
  }) as any;
  assertEquals(r, { error: RATE_UNAVAILABLE_ERROR });
  assert(!("totalReturns" in r));
});

Deno.test("runNexaTool: without a signed-in caller the estimate default stays the public rate", async () => {
  const anon = await runNexaTool("estimate_supporter_returns", '{"amount":100000,"months":1}', null, undefined, { defaultRate: 10 }) as any;
  assertEquals([anon.monthlyRatePercent, anon.totalReturns], [10, 10_000]);
});

Deno.test("tool defs: signed in, the estimate says an omitted rate is the caller's own and new partners need the public rate passed", () => {
  const est = (defs: ReturnType<typeof buildNexaToolDefs>) => defs.find((t) => t.function.name === "estimate_supporter_returns")!.function;
  const signedIn = est(buildNexaToolDefs({ publicRate: 10, ownRate: true }));
  assert(signedIn.description.includes("Omit rate to use the signed-in caller's own rate for a new portfolio"));
  assert(signedIn.description.includes("For new partners in general"));
  assert(signedIn.description.includes("pass rate 10 (the new-partner rate, 10% a month now)"));
  assert(!signedIn.description.includes("Omit rate for a new partner"));
  assert(String((signedIn.parameters as any).properties.rate.description).includes("own new-portfolio rate"));
  const signedInNoRate = est(buildNexaToolDefs({ publicRate: null, ownRate: true })).description;
  assert(signedInNoRate.includes("none is available right now, so give no figure"));
  assert(!/\d+%/.test(signedInNoRate));
  const anon = est(buildNexaToolDefs({ publicRate: 12.5, ownRate: false })).description;
  assert(anon.includes("Omit rate for a new partner (12.5% a month now)"));
  assert(!anon.includes("signed-in caller's own"));
});
