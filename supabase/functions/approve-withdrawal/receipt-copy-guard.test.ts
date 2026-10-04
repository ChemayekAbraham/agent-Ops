import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RECEIPT_ARCHIVE_EMAIL,
  buildReceiptCopyRecipients,
  enforceArchiveOnly,
} from "./receipt-copy-guard.ts";

// Gmail archive fan-out is retired (2026-07-16). Welile is the sole record
// of every payout receipt (Receipt Archive module).
Deno.test("legacy archive email constant is emptied", () => {
  assertEquals(RECEIPT_ARCHIVE_EMAIL, "");
});

Deno.test("no internal receipt copies are ever built", () => {
  assertEquals(buildReceiptCopyRecipients().length, 0);
});

Deno.test("guard rejects EVERY recipient (no external copies allowed)", () => {
  const { allowed, rejected } = enforceArchiveOnly([
    { email: "weliletenants@gmail.com", role: "Records Archive" },
    { email: "joshwanda17@gmail.com", role: "CFO" },
    { email: "some.manager@welile.com", role: "Manager" },
    { email: "agent@welile.com", role: "Merchant Agent" },
  ]);
  assertEquals(allowed.length, 0);
  assertEquals(rejected.length, 4);
  assert(rejected.some((r) => r.role === "CFO"));
  assert(rejected.some((r) => r.role === "Records Archive"));
});

// Source-level guard: the approve-withdrawal handler must not fan out receipt
// copies to role-derived staff addresses. It must never query user_roles for
// cfo/operations/manager to build a receipt recipient list.
Deno.test("approve-withdrawal source never sends to the Gmail archive", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(
    !/weliletenants@gmail\.com/i.test(src),
    "handler must not reference the retired weliletenants@gmail.com archive",
  );
  assert(
    !/copyRecipients\.push\([^)]*role:\s*["']CFO["']/.test(src),
    "handler must not push CFO addresses onto receipt copy list",
  );
});
