import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as React from "npm:react@18.3.1";
import { renderAsync } from "npm:@react-email/components@0.0.22";
import {
  buildCompoundEmailData,
  buildSchedule,
  type CompoundFacts,
  compoundEmailIdempotencyKey,
} from "./compoundEmail.ts";
import { template } from "./transactional-email-templates/partner-portfolio-compounded.tsx";

// A synthetic portfolio (not a real partner): capital 10,000,000, 15% a month,
// three compoundings so far, matures 27 Jan 2027, next return 28 Oct 2026.
const facts = (over: Partial<CompoundFacts> = {}): CompoundFacts => ({
  portfolio: {
    id: "11111111-1111-4111-8111-111111111111",
    code: "WIP2600000001",
    account_name: "ACCOUNT 1",
    roi_percentage: 15,
    maturity_date: "2027-01-27",
    next_roi_date: "2026-10-28",
    created_at: "2026-01-28T12:00:00+00:00",
  },
  partner: { id: "22222222-2222-4222-8222-222222222222", name: "Test Partner", email: "test@example.com" },
  compound: {
    at: "2026-09-28T07:33:06+00:00",
    reference: "CMP-TEST-0003",
    next_roi_date: "2026-10-28",
    return_amount: 1_983_750,
    new_principal: 15_208_750,
    opening_balance: 13_225_000,
  },
  compound_number: 3,
  returns_to_date: 5_208_750,
  capital_added: 10_000_000,
  ...over,
});

const textOf = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

Deno.test("figures add up: capital + returns = value; opening + return = value", () => {
  const d = buildCompoundEmailData(facts());
  assertEquals(d.capital_added + d.returns_to_date, d.new_total_partnership_value);
  assertEquals(d.opening_balance + d.return_amount, d.new_total_partnership_value);
  assertEquals(d.portfolio_id, "WIP2600000001"); // the code, never the account name
  assertEquals(d.compound_number, 3);
  assertEquals(d.compound_date, "28 September 2026");
});

Deno.test("schedule runs on the real return day and stops before maturity", () => {
  const d = buildCompoundEmailData(facts());
  assertEquals(d.schedule.map((r) => r.date), ["28 October 2026", "28 November 2026", "28 December 2026"]);
  assertEquals(d.schedule[0].balance_before, 15_208_750);
  assertEquals(d.schedule[0].return_amount, 2_281_313);
  assertEquals(d.schedule[0].balance_after, 17_490_063);
  // each row opens where the last one closed
  for (let i = 1; i < d.schedule.length; i++) {
    assertEquals(d.schedule[i].balance_before, d.schedule[i - 1].balance_after);
  }
});

Deno.test("a return that falls on or after maturity is not a cycle", () => {
  assertEquals(buildSchedule({ startingBalance: 1000, ratePct: 15, nextReturnDate: "2027-01-27", maturityDate: "2027-01-27" }), []);
  assertEquals(
    buildSchedule({ startingBalance: 1000, ratePct: 15, nextReturnDate: "2026-12-27", maturityDate: "2027-01-27" }).length,
    1,
  );
});

Deno.test("month-end return days are clamped, not skipped", () => {
  const rows = buildSchedule({ startingBalance: 1000, ratePct: 10, nextReturnDate: "2026-01-31", maturityDate: "2026-05-15" });
  assertEquals(rows.map((r) => r.date), ["31 January 2026", "28 February 2026", "31 March 2026", "30 April 2026"]);
});

Deno.test("no schedule without a maturity date or a rate", () => {
  assertEquals(buildCompoundEmailData(facts({ portfolio: { ...facts().portfolio, maturity_date: null } })).schedule, []);
  assertEquals(buildSchedule({ startingBalance: 1000, ratePct: 0, nextReturnDate: "2026-10-28", maturityDate: "2027-01-27" }), []);
});

Deno.test("one email per compounding event", () => {
  const k = (ref: string) => compoundEmailIdempotencyKey("p", "pf", ref);
  assertEquals(k("CMP-A"), k("CMP-A"));
  assert(k("CMP-A") !== k("CMP-B"));
});

Deno.test("the email says what the ledger says, in plain words", async () => {
  const data = buildCompoundEmailData(facts());
  const html = await renderAsync(React.createElement(template.component, data));
  const text = textOf(html);
  assert(text.includes("WIP2600000001"), "portfolio code");
  assert(!text.includes("ACCOUNT 1"), "account name must not stand in for the code");
  assert(text.includes("UGX 15,208,750"), "new value");
  assert(text.includes("UGX 13,225,000"), "opening balance");
  assert(text.includes("UGX 10,000,000 capital added"), "capital added");
  assert(text.includes("UGX 5,208,750 returns compounded so far"), "returns to date");
  assert(text.includes("compound 3 for this portfolio"), "compound number");
  assert(text.includes("28 October 2026"), "schedule uses the real return day");
  assert(text.includes("27 January 2027"), "maturity date is stated");
  assert(!/original contribution/i.test(text), "the mislabelled 'original contribution' sentence is gone");
  assert(!/\bcycle\b/i.test(text), "no cycle numbering");
  assert(!/\b(roi|interest|loan|lender)\b/i.test(text), "regulated wording");
});

Deno.test("an older sender (no recorded facts) still renders without the removed claim", async () => {
  const html = await renderAsync(React.createElement(template.component, {
    partner_name: "Test Partner",
    portfolio_id: "WIP2600000001",
    compound_date: "28 September 2026",
    initial_partnership_amount: 5_600_000,
    return_amount: 672_000,
    new_total_partnership_value: 6_272_000,
    roi_percentage: 12,
  }));
  const text = textOf(html);
  assert(text.includes("UGX 6,272,000"));
  assert(!/original contribution/i.test(text));
});
