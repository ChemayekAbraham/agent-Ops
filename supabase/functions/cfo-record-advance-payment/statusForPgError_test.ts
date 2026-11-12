// cfo-record-advance-payment: SQLSTATE -> HTTP, and the body the CFO screen reads.
// Run: deno test supabase/functions/cfo-record-advance-payment/statusForPgError_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { advancePaymentErrorBody, statusForPgError } from "./statusForPgError.ts";

Deno.test("P0001 (plpgsql RAISE EXCEPTION) is 400 and the body keeps the Postgres message", () => {
  assertEquals(statusForPgError("P0001"), 400);

  const insufficient = advancePaymentErrorBody({
    code: "P0001",
    message: "insufficient balance",
  });
  assertEquals(insufficient, {
    error: "insufficient balance",
    code: "P0001",
    recorded: false,
    rolled_back: true,
  });

  const category = advancePaymentErrorBody({
    code: "P0001",
    message: "disallowed ledger category: agent_repayment",
  });
  assertEquals(category.error, "disallowed ledger category: agent_repayment");
  assertEquals(category.code, "P0001");
  assertEquals(statusForPgError(category.code), 400);
});

Deno.test("every other SQLSTATE mapping is unchanged", () => {
  assertEquals(statusForPgError("28000"), 401);
  assertEquals(statusForPgError("42501"), 403);
  assertEquals(statusForPgError("22023"), 400);
  assertEquals(statusForPgError("0A000"), 422);
  assertEquals(statusForPgError("P0002"), 404);
  assertEquals(statusForPgError("XX000"), 500);
  assertEquals(statusForPgError(undefined), 500);
  assertEquals(statusForPgError(null), 500);
  assertEquals(statusForPgError(""), 500);
});

Deno.test("unmapped failures still carry the Postgres message", () => {
  assertEquals(
    advancePaymentErrorBody({ code: "XX000", message: "secret internals" }),
    { error: "secret internals", code: "XX000", recorded: false, rolled_back: true },
  );
  assertEquals(
    advancePaymentErrorBody({}),
    { error: null, code: null, recorded: false, rolled_back: true },
  );
});
