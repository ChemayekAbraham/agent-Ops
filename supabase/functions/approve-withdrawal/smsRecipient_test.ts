import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isStrictUgandanMobile, resolveWithdrawalSmsRecipient } from "./smsRecipient.ts";

const valid = isStrictUgandanMobile;

Deno.test("strict validator accepts the three Ugandan mobile forms", () => {
  assertEquals(isStrictUgandanMobile("+256772000111"), true);
  assertEquals(isStrictUgandanMobile("0772000111"), true);
  assertEquals(isStrictUgandanMobile("772000111"), true);
});

Deno.test("strict validator rejects longer, shorter and foreign numbers", () => {
  assertEquals(isStrictUgandanMobile("07888888888"), false); // 11 digits
  assertEquals(isStrictUgandanMobile("077200011"), false); // too short
  assertEquals(isStrictUgandanMobile("+254733803035"), false); // Kenyan
  assertEquals(isStrictUgandanMobile("+256172000111"), false); // not a 7X mobile
});

Deno.test("valid profile phone is kept", () => {
  assertEquals(resolveWithdrawalSmsRecipient("0772000111", { payout_method: "mobile_money", mobile_money_number: "0782266947" }, valid), { phone: "0772000111", fallback: false });
});

Deno.test("Kenyan profile phone falls back to MoMo number", () => {
  assertEquals(resolveWithdrawalSmsRecipient("+254733803035", { payout_method: "mobile_money", mobile_money_number: "0787373498" }, valid), { phone: "0787373498", fallback: true });
});

Deno.test("missing profile phone falls back to MoMo number", () => {
  assertEquals(resolveWithdrawalSmsRecipient(null, { payout_method: "mobile_money", mobile_money_number: "0787373498" }, valid).phone, "0787373498");
});

Deno.test("11-digit profile phone falls back to the MoMo number", () => {
  assertEquals(resolveWithdrawalSmsRecipient("07888888888", { payout_method: "mobile_money", mobile_money_number: "0782266947" }, valid), { phone: "0782266947", fallback: true });
});

Deno.test("bank transfer never falls back", () => {
  assertEquals(resolveWithdrawalSmsRecipient("+254733803035", { payout_method: "bank_transfer", mobile_money_number: "0787373498" }, valid), { phone: "+254733803035", fallback: false });
});

Deno.test("11-digit profile phone with bank transfer does not fall back", () => {
  assertEquals(resolveWithdrawalSmsRecipient("07888888888", { payout_method: "bank_transfer", mobile_money_number: "0782266947" }, valid), { phone: "07888888888", fallback: false });
});
