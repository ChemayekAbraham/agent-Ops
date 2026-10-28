import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SCHEDULED_PAYOUT_CATEGORIES as C } from "./categories.ts";

Deno.test("lunch allowance posts as payroll expense (Operational Expenses)", () => {
  assertEquals(C.lunch_allowance.platformCat, "payroll_expense");
});

Deno.test("lunch allowance still credits the staff wallet as a visible deposit", () => {
  assertEquals(C.lunch_allowance.walletCat, "wallet_deposit");
});
