import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveWithdrawalSmsRecipient } from "./smsRecipient.ts";
const valid = (p: string) => {
  const d = p.replace(/\D/g, "");
  const f = d.startsWith("256") ? `+${d}` : d.startsWith("0") ? `+256${d.slice(1)}` : `+${d}`;
  return f.startsWith("+256") && f.length >= 13;
};
Deno.test("valid profile phone is kept", () => {
  assertEquals(resolveWithdrawalSmsRecipient("0772000111", { payout_method: "mobile_money", mobile_money_number: "0782266947" }, valid), { phone: "0772000111", fallback: false });
});
Deno.test("Kenyan profile phone falls back to MoMo number", () => {
  assertEquals(resolveWithdrawalSmsRecipient("+254733803035", { payout_method: "mobile_money", mobile_money_number: "0787373498" }, valid), { phone: "0787373498", fallback: true });
});
Deno.test("missing profile phone falls back to MoMo number", () => {
  assertEquals(resolveWithdrawalSmsRecipient(null, { payout_method: "mobile_money", mobile_money_number: "0787373498" }, valid).phone, "0787373498");
});
Deno.test("bank transfer never falls back", () => {
  assertEquals(resolveWithdrawalSmsRecipient("+254733803035", { payout_method: "bank_transfer", mobile_money_number: "0787373498" }, valid), { phone: "+254733803035", fallback: false });
});
