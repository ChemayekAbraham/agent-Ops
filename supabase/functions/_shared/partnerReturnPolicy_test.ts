// Partner Returns Phase 4: the shared rate-reading module (design v2 section 1, tests T1.1-T1.10, T1.12)
// and the email templates' fail-closed behaviour (section 3.7).
// Run: deno test --allow-env --allow-read supabase/functions/_shared/partnerReturnPolicy_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as React from "npm:react@18.3.1";
import { renderAsync } from "npm:@react-email/components@0.0.22";
import {
  _resetPolicyCacheForTests,
  cachedPublicPolicy,
  cachedPublicPolicyResult,
  callerIsPartnerStaff,
  formatRatePct,
  monthlyReturnFor,
  PARTNER_STAFF_ROLES,
  parsePublicPolicy,
  PUBLIC_RATE_BASES,
  rateAwaitsCfo,
  rateEmailTarget,
  rateIsPublicForRow,
  rateOrNull,
  ratesPublicBeforeCutoff,
  readConfirmedLoginEmails,
  readPublicPolicy,
  readQuoteRate,
  readRentRewardRates,
  rowIsSwitchOff,
  rowRateIsPublic,
  singleRate,
  storedRate,
  typedRate,
  typedRateNeedsReload,
} from "./partnerReturnPolicy.ts";
import { buildPartnerCompoundCreationRequest, buildPartnerCompoundRequest, buildPartnershipAgreementRequest } from "./partnership-emails.ts";
import { template as proxyNudgeTemplate } from "./transactional-email-templates/proxy-daily-nudge.tsx";
import { template as houseBookingTemplate } from "./transactional-email-templates/funder-house-booking.tsx";
import { template as houseProgressTemplate } from "./transactional-email-templates/funder-house-progress.tsx";
import { template as savedFundableTemplate } from "./transactional-email-templates/funder-saved-house-fundable.tsx";
import { template as pledgeTemplate } from "./transactional-email-templates/promissory-note-pledge.tsx";
import { template as deploymentTemplate } from "./transactional-email-templates/partner-self-managed-deployment.tsx";
import { template as redemptionTemplate } from "./transactional-email-templates/portfolio-redemption.tsx";
import { template as inviteTemplate } from "./transactional-email-templates/partner-portfolio-invite.tsx";
import { template as agreementTemplate } from "./transactional-email-templates/partnership-agreement.tsx";
import { template as compoundTemplate } from "./transactional-email-templates/partner-compound.tsx";
import { template as compoundedTemplate } from "./transactional-email-templates/partner-portfolio-compounded.tsx";
import { template as disbursementTemplate } from "./transactional-email-templates/returns-disbursement-confirmation.tsx";

// ---- A fake Supabase client that records every call ----------------------------------------------------
type Answer = { data?: unknown; error?: { code?: string; message?: string } | null };
function fake(handlers: { rpc?: (name: string, args: unknown) => Answer | Promise<Answer>; select?: (table: string, filters: Record<string, unknown>) => Answer }) {
  const calls: { rpc: { name: string; args: unknown }[]; from: { table: string; filters: Record<string, unknown> }[] } = { rpc: [], from: [] };
  return {
    calls,
    rpc(name: string, args?: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(handlers.rpc ? handlers.rpc(name, args) : { data: null, error: null });
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      calls.from.push({ table, filters });
      const chain = {
        select: (cols: string) => { filters.select = cols; return chain; },
        in: (col: string, vals: unknown[]) => { filters[`in:${col}`] = vals; return chain; },
        eq: (col: string, val: unknown) => { filters[`eq:${col}`] = val; return chain; },
        limit: (n: number) => { filters.limit = n; return chain; },
        then: (ok: (a: Answer) => unknown, ko?: (e: unknown) => unknown) =>
          Promise.resolve(handlers.select ? handlers.select(table, filters) : { data: [], error: null }).then(ok, ko),
      };
      return chain;
    },
  };
}

const ON = { enabled: true, new_contract_rate: 10, policy_rate: 10, legacy_rate: 15, cutoff_at: "2026-12-01T00:00:00Z", enabled_at: "2026-12-01T00:00:00Z", updated_at: "2026-12-01T00:00:00Z" };
const OFF = { enabled: false, new_contract_rate: 15, policy_rate: 10, legacy_rate: 15, cutoff_at: null, enabled_at: null, updated_at: "2026-11-05T00:00:00Z" };

// ---- T1.1 rateOrNull / storedRate ----------------------------------------------------------------------
Deno.test("T1.1 rateOrNull accepts (0, 100] numbers and numeric strings only; storedRate has no fallback", () => {
  assertEquals(rateOrNull(15), 15);
  assertEquals(rateOrNull("10.00"), 10);
  assertEquals(rateOrNull(100), 100);
  assertEquals(rateOrNull(12.5), 12.5);
  for (const bad of [0, -1, 100.01, NaN, Infinity, null, undefined, "", " ", "abc", true, {}, []]) {
    assertEquals(rateOrNull(bad), null, `rateOrNull(${String(bad)})`);
  }
  assertEquals(storedRate({ roi_percentage: "20" }), 20);
  assertEquals(storedRate({ roi_percentage: null }), null);
  assertEquals(storedRate({}), null);
  assertEquals(storedRate(null), null);
});

// ---- T1.2 typedRate ------------------------------------------------------------------------------------
Deno.test("T1.2 typedRate: absent -> null, valid -> number, anything else -> 'invalid'", () => {
  for (const absent of [undefined, null, "", "   "]) assertEquals(typedRate(absent), null);
  assertEquals(typedRate(20), 20);
  assertEquals(typedRate("12.5"), 12.5);
  for (const bad of [0, -5, 101, "x", true, {}, NaN]) assertEquals(typedRate(bad), "invalid", `typedRate(${String(bad)})`);
});

// ---- T1.3 rateAwaitsCfo --------------------------------------------------------------------------------
Deno.test("T1.3 rateAwaitsCfo only when a typed rate differs from the stored one", () => {
  assertEquals(rateAwaitsCfo(20, 15), true);
  assertEquals(rateAwaitsCfo(15, 15), false);
  assertEquals(rateAwaitsCfo(15, 15.001), false);   // same to the cent
  assertEquals(rateAwaitsCfo(null, 15), false);
  assertEquals(rateAwaitsCfo(20, null), false);
});

// ---- T1.4 monthlyReturnFor parity ----------------------------------------------------------------------
Deno.test("T1.4 monthlyReturnFor equals today's Math.round(a * 0.15) for every integer up to 2,000,000 at 15", () => {
  for (let a = 0; a <= 2_000_000; a++) {
    if (monthlyReturnFor(a, 15) !== Math.round(a * 0.15)) throw new Error(`mismatch at ${a}`);
  }
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 200_000; i++) {
    const a = Math.floor(rnd() * 5e8);
    if (monthlyReturnFor(a, 15) !== Math.round(a * 0.15)) throw new Error(`mismatch at ${a}`);
  }
  assertEquals(monthlyReturnFor(1_000_000, 10), 100_000);
  assertEquals(monthlyReturnFor("1000000", 10), 100_000);
  assertEquals(monthlyReturnFor(1_000_000, null), null);
  assertEquals(monthlyReturnFor(null, 10), null);
  assertEquals(monthlyReturnFor(-5, 10), null);
});

// ---- T1.5 formatRatePct, singleRate, row bases ----------------------------------------------------------
Deno.test("T1.5 formatRatePct, singleRate and the row-basis helpers", () => {
  assertEquals(formatRatePct(10), "10%");
  assertEquals(formatRatePct(12.5), "12.5%");
  assertEquals(formatRatePct(14.999), "15%");
  assertEquals(formatRatePct(null), null);
  assertEquals(formatRatePct(0), null);
  assertEquals(singleRate([15, 15, 15]), 15);
  assertEquals(singleRate([15, 10]), null);
  assertEquals(singleRate([15, null]), null);
  assertEquals(singleRate([]), null);
  assertEquals(PUBLIC_RATE_BASES.slice(), ["switch_off", "typed_switch_off", "new_no_investor"]);
  for (const b of PUBLIC_RATE_BASES) assert(rateIsPublicForRow({ rate_basis: b }));
  for (const b of ["new", "existing_partner", "employee", "carried", "signed_agreement", "salary_reinvestment", null, undefined]) {
    assert(!rateIsPublicForRow({ rate_basis: b }), `basis ${b}`);
  }
  assert(!rateIsPublicForRow(null));
  assert(rowIsSwitchOff({ rate_basis: "switch_off" }) && rowIsSwitchOff({ rate_basis: "typed_switch_off" }));
  assert(!rowIsSwitchOff({ rate_basis: "new_no_investor" }));
});

// ---- T1.6 parsePublicPolicy / readPublicPolicy -----------------------------------------------------------
Deno.test("T1.6 parsePublicPolicy: malformed -> null; readPublicPolicy makes exactly one RPC", async () => {
  assertEquals(parsePublicPolicy(ON), { enabled: true, newContractRate: 10, cutoffAt: ON.cutoff_at, enabledAt: ON.enabled_at, updatedAt: ON.updated_at, noteDueBy: null });
  assertEquals(parsePublicPolicy({ ...OFF, note_due_by: "2026-12-31" })?.noteDueBy, "2026-12-31");
  assertEquals(parsePublicPolicy({ ...OFF, note_due_by: "31 Dec" })?.noteDueBy, null);
  assertEquals(parsePublicPolicy({ ...OFF, new_contract_rate: "15.00" })?.newContractRate, 15);
  for (const bad of [null, undefined, "x", [], {}, { enabled: "true", new_contract_rate: 10 }, { enabled: true }, { enabled: true, new_contract_rate: 0 }]) {
    assertEquals(parsePublicPolicy(bad), null);
  }
  const c = fake({ rpc: () => ({ data: OFF, error: null }) });
  assertEquals((await readPublicPolicy(c))?.enabled, false);
  assertEquals(c.calls.rpc.map((r) => r.name), ["get_partner_return_policy"]);
  assertEquals(await readPublicPolicy(fake({ rpc: () => ({ data: null, error: { code: "PGRST202", message: "missing" } }) })), null);
  assertEquals(await readPublicPolicy({ rpc: () => { throw new Error("network"); } }), null);
});

// ---- T1.7 cachedPublicPolicy -----------------------------------------------------------------------------
Deno.test("T1.7 cachedPublicPolicy: one RPC within the ttl; a failure is cached 10 s with its code", async () => {
  _resetPolicyCacheForTests();
  const c = fake({ rpc: () => ({ data: ON, error: null }) });
  assertEquals((await cachedPublicPolicy(c))?.newContractRate, 10);
  assertEquals((await cachedPublicPolicy(c))?.newContractRate, 10);
  assertEquals(c.calls.rpc.length, 1);

  _resetPolicyCacheForTests();
  const failing = fake({ rpc: () => ({ data: null, error: { code: "PGRST202", message: "missing" } }) });
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    assertEquals(await cachedPublicPolicyResult(failing), { policy: null, errorCode: "PGRST202" });
    t += 9_000;
    await cachedPublicPolicy(failing);
    assertEquals(failing.calls.rpc.length, 1);            // still cached
    t += 2_000;
    await cachedPublicPolicy(failing);
    assertEquals(failing.calls.rpc.length, 2);            // retried after 10 s
  } finally {
    Date.now = realNow;
    _resetPolicyCacheForTests();
  }

  // Concurrent callers share one read.
  const slow = fake({ rpc: () => new Promise((r) => setTimeout(() => r({ data: OFF, error: null }), 5)) });
  await Promise.all([cachedPublicPolicy(slow), cachedPublicPolicy(slow), cachedPublicPolicy(slow)]);
  assertEquals(slow.calls.rpc.length, 1);
  _resetPolicyCacheForTests();
});

// ---- T1.8 readQuoteRate ----------------------------------------------------------------------------------
Deno.test("T1.8 readQuoteRate: number only, null on any error; 'partner' without id makes no call", async () => {
  const ok = fake({ rpc: () => ({ data: "20.00", error: null }) });
  assertEquals(await readQuoteRate(ok, "me"), 20);
  assertEquals(ok.calls.rpc[0], { name: "partner_quote_rate", args: { p_quote_for: "me", p_partner_id: null } });
  assertEquals(await readQuoteRate(ok, "partner", "p1"), 20);
  assertEquals(ok.calls.rpc[1].args, { p_quote_for: "partner", p_partner_id: "p1" });

  const none = fake({});
  assertEquals(await readQuoteRate(none, "partner"), null);
  assertEquals(none.calls.rpc.length, 0);
  assertEquals(await readQuoteRate(fake({ rpc: () => ({ data: null, error: { code: "42501", message: "AUTH_REQUIRED" } }) }), "me"), null);
  assertEquals(await readQuoteRate(fake({ rpc: () => ({ data: 0, error: null }) }), "me"), null);
});

// ---- T1.9 readRentRewardRates ----------------------------------------------------------------------------
Deno.test("T1.9 readRentRewardRates: one select per 100 ids, scoped to the supporter", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `rr${i}`);
  const c = fake({
    select: (_t, f) => ({ data: (f["in:rent_request_id"] as string[]).map((id) => ({ rent_request_id: id, rate: "15.00" })), error: null }),
  });
  const m = await readRentRewardRates(c, [...ids, "rr0"], "sup");
  assertEquals(c.calls.from.length, 3);
  assert(c.calls.from.every((f) => f.table === "rent_facilitation_reward_rates" && f.filters["eq:supporter_id"] === "sup"));
  assertEquals(m.size, 250);
  assertEquals(m.get("rr7"), 15);
  const failing = fake({ select: () => ({ data: null, error: { message: "boom" } }) });
  assertEquals((await readRentRewardRates(failing, ["a"], "sup")).size, 0);
  assertEquals((await readRentRewardRates(fake({}), [], "sup")).size, 0);
});

// ---- T1.10 rateEmailTarget / readConfirmedLoginEmails ------------------------------------------------------
Deno.test("T1.10 rateEmailTarget: public -> profile with figures; personal -> login, or profile without figures", () => {
  assertEquals(rateEmailTarget("login@x.com", "profile@x.com", true), { to: "profile@x.com", withFigures: true });
  assertEquals(rateEmailTarget("login@x.com", "profile@x.com", false), { to: "login@x.com", withFigures: true });
  assertEquals(rateEmailTarget(null, "profile@x.com", false), { to: "profile@x.com", withFigures: false });
  assertEquals(rateEmailTarget("  ", " ", false), { to: null, withFigures: false });
  assertEquals(rateEmailTarget(null, null, true), { to: null, withFigures: true });
});

Deno.test("T1.10b before the first switch-on every row's rate is public; afterwards only a public basis", async () => {
  // Pure check: an unstamped row (rate_basis NULL, written before Phase 1) or no row follows noCutoffYet;
  // a stamped basis always speaks for itself (a stale "no cut-off" can never publish a post-cut-off row).
  for (const row of [{ rate_basis: null }, { rate_basis: undefined }, {}, null, undefined]) {
    assert(rateIsPublicForRow(row, true), `unstamped ${JSON.stringify(row)} before the cut-off`);
    assert(!rateIsPublicForRow(row, false), `unstamped ${JSON.stringify(row)} after the cut-off`);
  }
  for (const b of PUBLIC_RATE_BASES) assert(rateIsPublicForRow({ rate_basis: b }, false));
  for (const b of ["new", "existing_partner", "employee", "carried", "signed_agreement", "salary_reinvestment", "promissory_note"]) {
    assert(!rateIsPublicForRow({ rate_basis: b }, true), `stamped ${b} stays personal`);
  }

  // ratesPublicBeforeCutoff: true only for a readable policy with no cut-off; fails closed.
  _resetPolicyCacheForTests();
  assertEquals(await ratesPublicBeforeCutoff(fake({ rpc: () => ({ data: OFF, error: null }) })), true);
  _resetPolicyCacheForTests();
  assertEquals(await ratesPublicBeforeCutoff(fake({ rpc: () => ({ data: ON, error: null }) })), false);
  _resetPolicyCacheForTests();
  // Switched off again after a cut-off: the cut-off stays, so personal rules hold.
  assertEquals(await ratesPublicBeforeCutoff(fake({ rpc: () => ({ data: { ...ON, enabled: false, new_contract_rate: 15 }, error: null }) })), false);
  _resetPolicyCacheForTests();
  assertEquals(await ratesPublicBeforeCutoff(fake({ rpc: () => ({ data: null, error: { code: "PGRST202", message: "missing" } }) })), false);
  _resetPolicyCacheForTests();

  // rowRateIsPublic: no RPC for a stamped row; one cached RPC for unstamped rows.
  const off = fake({ rpc: () => ({ data: OFF, error: null }) });
  assertEquals(await rowRateIsPublic(off, { rate_basis: "existing_partner" }), false);
  assertEquals(await rowRateIsPublic(off, { rate_basis: "switch_off" }), true);
  assertEquals(off.calls.rpc.length, 0);
  assertEquals(await rowRateIsPublic(off, { rate_basis: null }), true);
  assertEquals(await rowRateIsPublic(off, { rate_basis: null }), true);
  assertEquals(off.calls.rpc.map((r) => r.name), ["get_partner_return_policy"]);
  _resetPolicyCacheForTests();
  const on = fake({ rpc: () => ({ data: ON, error: null }) });
  assertEquals(await rowRateIsPublic(on, { rate_basis: null }), false);
  _resetPolicyCacheForTests();
});

Deno.test("T1.10 readConfirmedLoginEmails: one RPC per 1000 ids; an error adds nothing", async () => {
  const ids = Array.from({ length: 2500 }, (_, i) => `u${i}`);
  const c = fake({ rpc: (_n, a) => ({ data: ((a as { p_ids: string[] }).p_ids).map((id) => ({ user_id: id, email: `${id}@x.com` })), error: null }) });
  const m = await readConfirmedLoginEmails(c, ids);
  assertEquals(c.calls.rpc.length, 3);
  assert(c.calls.rpc.every((r) => r.name === "partner_confirmed_login_emails"));
  assertEquals(m.size, 2500);
  assertEquals(m.get("u5"), "u5@x.com");
  assertEquals((await readConfirmedLoginEmails(fake({ rpc: () => ({ data: null, error: { message: "boom" } }) }), ["a"])).size, 0);
  assertEquals((await readConfirmedLoginEmails(fake({}), [])).size, 0);
});

// ---- staff guard helpers -------------------------------------------------------------------------------
Deno.test("409 guard: a typed rate is refused only when the screen did not see the switch on and the live policy is on or unreadable", async () => {
  const on = fake({ rpc: () => ({ data: ON, error: null }) });
  const off = fake({ rpc: () => ({ data: OFF, error: null }) });
  const broken = fake({ rpc: () => ({ data: null, error: { message: "x" } }) });
  assertEquals(await typedRateNeedsReload(on, false, undefined), false);   // nothing typed: no read
  assertEquals(on.calls.rpc.length, 0);
  assertEquals(await typedRateNeedsReload(on, true, true), false);         // new screen saw the switch on
  assertEquals(on.calls.rpc.length, 0);
  assertEquals(await typedRateNeedsReload(on, true, undefined), true);     // old bundle after switch-on
  assertEquals(await typedRateNeedsReload(off, true, false), false);       // switch off: proceed
  assertEquals(await typedRateNeedsReload(broken, true, undefined), true); // unreadable: fail closed
});

Deno.test("callerIsPartnerStaff: one select of enabled partner-staff roles; false on error", async () => {
  const c = fake({ select: () => ({ data: [{ role: "cfo" }], error: null }) });
  assertEquals(await callerIsPartnerStaff(c, "u1"), true);
  assertEquals(c.calls.from[0].filters["eq:enabled"], true);
  assertEquals(c.calls.from[0].filters["in:role"], [...PARTNER_STAFF_ROLES]);
  assertEquals(await callerIsPartnerStaff(fake({ select: () => ({ data: [], error: null }) }), "u1"), false);
  assertEquals(await callerIsPartnerStaff(fake({ select: () => ({ data: null, error: { message: "x" } }) }), "u1"), false);
  assertEquals(await callerIsPartnerStaff(fake({}), null), false);
});

// ---- T1.12 the staff list matches the SQL --------------------------------------------------------------
Deno.test("T1.12 PARTNER_STAFF_ROLES equals the role arrays of partner_quote_rate (Phase 2) and partner_rate_visible_to_caller (4a)", async () => {
  const migrations = new URL("../../migrations/", import.meta.url);
  const arrayAfter = (sql: string, fn: string) => {
    const at = sql.indexOf(`FUNCTION public.${fn}(`);
    assert(at >= 0, `${fn} not found`);
    const m = /ARRAY\[([^\]]*)\]/.exec(sql.slice(at));
    assert(m, `no role array in ${fn}`);
    return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  };
  const want = [...PARTNER_STAFF_ROLES].sort();
  let checkedPhase2 = false;
  for await (const e of Deno.readDir(migrations)) {
    if (!e.name.endsWith("_partner_return_policy_phase2.sql")) continue;
    const phase2 = await Deno.readTextFile(new URL(e.name, migrations));
    assertEquals(arrayAfter(phase2, "partner_quote_rate"), want);
    checkedPhase2 = true;
  }
  assert(checkedPhase2, "Phase 2 migration not found");
  // The 4a file is written by the SQL builder; check it whenever it is present (any re-stamped name).
  for await (const e of Deno.readDir(migrations)) {
    if (!e.name.endsWith("_partner_return_policy_phase4.sql")) continue;
    const sql4a = await Deno.readTextFile(new URL(e.name, migrations));
    assertEquals(arrayAfter(sql4a, "partner_rate_visible_to_caller"), want);
  }
});

// ---- partnership-emails: no derived rates (C10) ----------------------------------------------------------
Deno.test("partnership emails never derive a rate from amounts; no rate -> no rate fields", () => {
  const base = {
    recipientEmail: "a@b.c", partnerName: "P", partnerId: "p", portfolioId: "f", amount: 1_000_000,
    contributionDateIso: "2026-11-01T00:00:00Z", firstPayoutDateIso: "2026-12-01T00:00:00Z", payoutDay: 1,
  };
  const noRate = buildPartnershipAgreementRequest({ ...base, monthlyReward: 150_000 }).templateData as Record<string, unknown>;
  assert(!("roi_percentage" in noRate));
  assertEquals(noRate.monthly_return_amount, 150_000);
  const noFigures = buildPartnershipAgreementRequest({ ...base, monthlyReward: null, roiPercentage: null }).templateData as Record<string, unknown>;
  for (const k of ["roi_percentage", "monthly_return_amount", "total_projected_return"]) assert(!(k in noFigures), k);
  const withRate = buildPartnershipAgreementRequest({ ...base, monthlyReward: 100_000, roiPercentage: 10 }).templateData as Record<string, unknown>;
  assertEquals(withRate.roi_percentage, 10);
  assertEquals(withRate.total_projected_return, 1_200_000);

  const compound = buildPartnerCompoundRequest({ recipientEmail: "a", partnerName: "P", partnerId: "p", portfolioId: "f", paymentNumber: 2, initialAmount: 1_000_000, returnAmount: 150_000, newTotal: 1_150_000 }).templateData as Record<string, unknown>;
  assert(!("roi_percentage" in compound) && !("roi_return" in compound));
  const compoundPaid = buildPartnerCompoundRequest({ recipientEmail: "a", partnerName: "P", partnerId: "p", portfolioId: "f", paymentNumber: 2, initialAmount: 1_000_000, roiPercentage: 10, returnAmount: 100_000, newTotal: 1_100_000 }).templateData as Record<string, unknown>;
  assertEquals(compoundPaid.roi_return, "10%");

  const creation = buildPartnerCompoundCreationRequest({ recipientEmail: "a", partnerName: "P", partnerId: "p", portfolioId: "f", initialAmount: 1_000_000, roiPercentage: null }).templateData as Record<string, unknown>;
  for (const k of ["roi_percentage", "roi_return", "return_amount", "new_total_partnership_value"]) assert(!(k in creation), k);
  const creation15 = buildPartnerCompoundCreationRequest({ recipientEmail: "a", partnerName: "P", partnerId: "p", portfolioId: "f", initialAmount: 1_000_000, roiPercentage: 15 }).templateData as Record<string, unknown>;
  assertEquals([creation15.return_amount, creation15.new_total_partnership_value, creation15.roi_return], [150_000, 1_150_000, "15%"]);
});

// ---- Templates: no default rate; figures optional (section 3.7) ----------------------------------------
const html = (t: { component: unknown; previewData?: unknown }, props: Record<string, unknown>) =>
  renderAsync(React.createElement(t.component as React.FC<Record<string, unknown>>, { ...(t.previewData as object ?? {}), ...props }));
const text = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

Deno.test("templates state only the rate they are given, and never 15% by default", async () => {
  const nudge10 = text(await html(proxyNudgeTemplate, { partner_rate: 10 }));
  assert(nudge10.includes("New partners earn 10% Returns a month on the rent they contribute."));
  const nudgeNone = text(await html(proxyNudgeTemplate, { partner_rate: null }));
  assert(!/\d+% /.test(nudgeNone) && !nudgeNone.includes("They earn"));

  const funded10 = text(await html(houseBookingTemplate, { kind: "funded", return_rate: 10, monthly_return: 90_000 }));
  assert(funded10.includes("You will earn Returns of 10% per month on the capital you deployed."));
  assert(funded10.includes("that is 10% of your money"));
  const fundedNone = text(await html(houseBookingTemplate, { kind: "funded", return_rate: undefined, monthly_return: 0 }));
  assert(fundedNone.includes("Your monthly Returns will show on your dashboard once the houses are funded."));
  assert(!/\b15%/.test(fundedNone) && !fundedNone.includes("% of your money"));

  for (const [t, props] of [
    [houseProgressTemplate, { return_rate: undefined }],
    [savedFundableTemplate, { return_rate: undefined }],
    [pledgeTemplate, { roi_percentage: undefined }],
    [deploymentTemplate, { roi_percentage: undefined, monthly_return_amount: undefined }],
    [redemptionTemplate, { return_rate: undefined }],
    [inviteTemplate, { roi_percentage: undefined }],
    [agreementTemplate, { roi_percentage: undefined, monthly_return_amount: undefined, total_projected_return: undefined }],
    [compoundTemplate, { roi_percentage: undefined, roi_return: undefined, return_amount: undefined, new_total_partnership_value: undefined }],
    [compoundedTemplate, { roi_percentage: undefined, roi_return: undefined, schedule: undefined }],
    [disbursementTemplate, { roi_percentage: undefined }],
  ] as const) {
    const out = text(await html(t, props as Record<string, unknown>));
    assert(!/\b15%/.test(out), `${t.displayName}: shows 15% with no rate`);
    assert(!/\b0% /.test(out), `${t.displayName}: shows 0% with no rate`);
  }

  const agreementNone = text(await html(agreementTemplate, { roi_percentage: undefined, monthly_return_amount: undefined, total_projected_return: undefined }));
  assert(agreementNone.includes("Shown on your dashboard"));
  assert(!agreementNone.includes("Agreed Monthly Return") && !agreementNone.includes("Total Projected Return"));
  const agreement12 = text(await html(agreementTemplate, { roi_percentage: 12, monthly_return_amount: 120_000, total_projected_return: 1_440_000 }));
  assert(agreement12.includes("12%") && agreement12.includes("UGX 120,000"));

  const disb = text(await html(disbursementTemplate, { roi_percentage: 10 }));
  assert(disb.includes("Agreed monthly Returns rate") && !/\bROI\b/.test(disb));
});

Deno.test("template copy added in Phase 4 stays within the regulatory words", async () => {
  const outs = [
    text(await html(proxyNudgeTemplate, { partner_rate: 10 })),
    text(await html(houseBookingTemplate, { kind: "funded", return_rate: null, monthly_return: 0 })),
    text(await html(agreementTemplate, { roi_percentage: undefined, monthly_return_amount: undefined, total_projected_return: undefined })),
    text(await html(disbursementTemplate, { roi_percentage: 10 })),
  ];
  for (const o of outs) for (const banned of [/\binterest\b/i, /\bloan\b/i, /\blender\b/i, /\bROI\b/]) assert(!banned.test(o), `found ${banned}`);
});

// ---- T1.11 static scans (design v2 section 10.1) ---------------------------------------------------------
// Reads files only. The allow-list (supabase/tests/partner_return_policy/static_scan_allowlist.json) names
// every accepted match by file and exact line text, with a reason; anything else fails with file:line.
const REPO = new URL("../../../", import.meta.url);
type AllowEntry = { line: number; text: string; reason: string };
const scanAllow = JSON.parse(
  await Deno.readTextFile(new URL("supabase/tests/partner_return_policy/static_scan_allowlist.json", REPO)),
) as { phase4_files: string[]; fifteen: Record<string, AllowEntry[]>; words: Record<string, AllowEntry[]> };

const FIFTEEN_PATTERNS: RegExp[] = [
  /(\?\?|\|\|)\s*15\b/, /\b0?\.15\b/, /\b15\s*\/\s*100\b/, /=\s*15\s*[,;)]/, /\b15%/, /[A-Z_]*RATE\s*=\s*1[05]\b/,
  /LEGACY_PARTNER_RETURN_RATE/, /partner_agreement_terms/, /renewalRateFor/,
];
/** Rate derived from amounts (reward / principal): checked in _shared only. */
const SHARED_DERIVATION = /initialAmount|\.amount\s*>\s*0\s*\?\s*Math\.round\(\(/;
const BANNED_WORDS = /\b(ROI|[Ii]nterest|INTEREST|[Ll]oans?|LOANS?|[Ll]enders?|LENDERS?)\b/;
const isTestFile = (rel: string) => /(_test|\.test|\.spec)\.(ts|tsx)$/.test(rel) || rel.includes("/__tests__/");
const isCommentLine = (t: string) => /^(\/\/|\*|\/\*|\{\/\*|console\.)/.test(t);

async function sourceFiles(dirRel: string, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(new URL(dirRel, REPO))) {
    const rel = `${dirRel}${e.name}`;
    if (e.isDirectory) {
      if (e.name !== "node_modules") await sourceFiles(`${rel}/`, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !isTestFile(rel)) out.push(rel);
  }
  return out;
}

/** Matches not covered by the allow-list (file + exact text, with multiplicity). */
function unlisted(rel: string, lines: string[], match: (t: string) => boolean, allow: AllowEntry[] | undefined): string[] {
  const budget = new Map<string, number>();
  for (const a of allow ?? []) budget.set(a.text, (budget.get(a.text) ?? 0) + 1);
  const out: string[] = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || isCommentLine(t) || !match(t)) return;
    const left = budget.get(t) ?? 0;
    if (left > 0) budget.set(t, left - 1);
    else out.push(`${rel}:${i + 1}: ${t.slice(0, 160)}`);
  });
  return out;
}

Deno.test("T1.11 no 15% fallback, fixed 15 rate or rate-from-amounts outside the allow-list (supabase/functions, src/lib, src/hooks)", async () => {
  const offenders: string[] = [];
  for (const root of ["supabase/functions/", "src/lib/", "src/hooks/"]) {
    for (const rel of await sourceFiles(root)) {
      const lines = (await Deno.readTextFile(new URL(rel, REPO))).split(/\r?\n/);
      const shared = rel.startsWith("supabase/functions/_shared/");
      offenders.push(...unlisted(rel, lines, (t) => FIFTEEN_PATTERNS.some((re) => re.test(t)) || (shared && SHARED_DERIVATION.test(t)), scanAllow.fifteen[rel]));
    }
  }
  assertEquals(offenders, []);
});

Deno.test("T1.11 no new ROI / interest / loan / lender in the files Phase 4 changed", async () => {
  const offenders: string[] = [];
  for (const rel of scanAllow.phase4_files) {
    const lines = (await Deno.readTextFile(new URL(rel, REPO))).split(/\r?\n/);
    offenders.push(...unlisted(rel, lines, (t) => BANNED_WORDS.test(t), scanAllow.words[rel]));
  }
  assertEquals(offenders, []);
});

Deno.test("T1.11 the allow-list itself: every entry has a reason; no Phase 4 helper is allow-listed as a 15 fallback", () => {
  for (const [rel, entries] of Object.entries(scanAllow.fifteen)) {
    for (const e of entries) assert(e.reason && e.text, `${rel}:${e.line} has no reason`);
    assert(!rel.endsWith("_shared/partnerReturnPolicy.ts") && !rel.endsWith("src/lib/partnerReturnPolicy.ts"), `${rel} must have no 15 at all`);
  }
});

Deno.test("T1.11 the allow-list has no stale entries (an entry whose text left its file could hide the line coming back)", async () => {
  const stale: string[] = [];
  for (const section of [scanAllow.fifteen, scanAllow.words]) {
    for (const [rel, entries] of Object.entries(section)) {
      const lines = new Set((await Deno.readTextFile(new URL(rel, REPO))).split(/\r?\n/).map((l) => l.trim()));
      for (const e of entries) if (!lines.has(e.text)) stale.push(`${rel}:${e.line}: ${e.text.slice(0, 120)}`);
    }
  }
  assertEquals(stale, []);
});
