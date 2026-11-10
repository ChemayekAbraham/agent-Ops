import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { previewDescription, rateFreeDescription, storedDescriptionIsStale } from "./preview.ts";
import type { PublicReturnPolicy } from "../_shared/partnerReturnPolicy.ts";

const STORED = "Support this tenant for UGX 300,000 by paying their landlord on the platform and earn UGX 45,000 per month for the next 12 months Start here today.";
const plan = { funding_amount: 300_000 };
const off: PublicReturnPolicy = { enabled: false, newContractRate: 15, cutoffAt: null, enabledAt: null, updatedAt: "2026-11-08T10:00:00Z", noteDueBy: "2026-12-31" };
const on: PublicReturnPolicy = { enabled: true, newContractRate: 10, cutoffAt: "2026-12-01T00:00:00Z", enabledAt: "2026-12-01T00:00:00Z", updatedAt: "2026-12-01T00:00:00Z", noteDueBy: null };

Deno.test("no cut-off yet: the stored description wins byte for byte (switch-off parity)", () => {
  assertEquals(previewDescription({ og_description: STORED, og_updated_at: "2026-09-01T00:00:00Z" }, plan, off, null), STORED);
  assertEquals(previewDescription({ og_description: STORED, og_updated_at: null }, plan, off, null), STORED);
});

Deno.test("after a cut-off: a description written before the policy change is replaced by rate-free text", () => {
  const stale = previewDescription({ og_description: STORED, og_updated_at: "2026-11-30T00:00:00Z" }, plan, on, null);
  assertEquals(stale, rateFreeDescription(plan));
  assert(!/\d+%|UGX 45,000/.test(stale));
  // Re-shared after the switch: SQL rebuilt the text at the new rate, so it is served.
  const fresh = "Support this tenant for UGX 300,000 ... earn UGX 30,000 per month ...";
  assertEquals(previewDescription({ og_description: fresh, og_updated_at: "2026-12-02T00:00:00Z" }, plan, on, null), fresh);
  // Missing or unreadable timestamps fail closed.
  assertEquals(previewDescription({ og_description: STORED, og_updated_at: null }, plan, on, null), rateFreeDescription(plan));
  assertEquals(previewDescription({ og_description: STORED, og_updated_at: "not a date" }, plan, on, null), rateFreeDescription(plan));
  assert(storedDescriptionIsStale({ og_updated_at: "2026-12-02T00:00:00Z" }, { ...on, updatedAt: null }, null));
});

Deno.test("policy function missing (PGRST202 / 42883): keep the stored text", () => {
  assertEquals(previewDescription({ og_description: STORED }, plan, null, { code: "PGRST202" }), STORED);
  assertEquals(previewDescription({ og_description: STORED }, plan, null, { code: "42883" }), STORED);
});

Deno.test("any other policy failure: rate-free text", () => {
  for (const code of ["PGRST301", "57014", "error", "exception", null]) {
    assertEquals(previewDescription({ og_description: STORED }, plan, null, { code }), rateFreeDescription(plan), String(code));
  }
  assertEquals(previewDescription({ og_description: STORED }, plan, null, null), rateFreeDescription(plan));
});

Deno.test("no stored description: rate-free sentence, never a computed figure", () => {
  assertEquals(
    previewDescription({ og_description: null }, plan, off, null),
    "Support this tenant for UGX 300,000 by paying their landlord on the platform and earn monthly Returns. Start here today.",
  );
  assertEquals(
    previewDescription({}, { funding_amount: null }, on, null),
    "Support a tenant's rent on Welile and earn monthly Returns. Support today.",
  );
  assertEquals(previewDescription({ og_description: "" }, null, off, null), "Support a tenant's rent on Welile and earn monthly Returns. Support today.");
  for (const p of [off, on, null]) {
    const text = previewDescription({}, plan, p, null);
    assert(!/%|per month/.test(text), text);
  }
});
