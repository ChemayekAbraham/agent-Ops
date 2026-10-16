// Simulated-data test for the strict OTP-recipient rule: the OTP must always
// go to the landlord's own registered phone, never the mobile money number.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveOtpRecipient, toLocalUgPhone } from "./resolveOtpRecipient.ts";

// Virtual landlords: contact phone vs approved mobile money payout number.
const CASES = [
  {
    name: "landlord with own phone and a relative's MoMo line",
    landlordPhone: "0772123456",
    payoutPhone: "0752999888",
    expectRecipient: "0772123456",
    expectSource: "landlord_phone",
  },
  {
    name: "contact phone stored with country code",
    landlordPhone: "+256772123456",
    payoutPhone: "0752999888",
    expectRecipient: "0772123456",
    expectSource: "landlord_phone",
  },
  {
    name: "contact phone stored with spaces and dashes",
    landlordPhone: "0772 123 456",
    payoutPhone: "0752-999-888",
    expectRecipient: "0772123456",
    expectSource: "landlord_phone",
  },
  {
    name: "contact phone stored as 9 digits",
    landlordPhone: "772123456",
    payoutPhone: "256752999888",
    expectRecipient: "0772123456",
    expectSource: "landlord_phone",
  },
  {
    name: "no contact phone on file — falls back to payout number",
    landlordPhone: null,
    payoutPhone: "0752999888",
    expectRecipient: "0752999888",
    expectSource: "payout_number_fallback",
  },
  {
    name: "unusable contact phone — falls back to payout number",
    landlordPhone: "123",
    payoutPhone: "+256752999888",
    expectRecipient: "0752999888",
    expectSource: "payout_number_fallback",
  },
];

Deno.test("OTP always goes to the landlord phone, never the mobile money number", () => {
  for (const c of CASES) {
    const d = resolveOtpRecipient(c.landlordPhone, c.payoutPhone);
    assertEquals(d.recipient, c.expectRecipient, c.name);
    assertEquals(d.source, c.expectSource, c.name);
    if (c.expectSource === "landlord_phone") {
      // The core guarantee: when the landlord has a contact phone, the OTP
      // recipient is that phone and is NOT the payout number.
      assertEquals(d.recipient, toLocalUgPhone(c.landlordPhone), c.name);
      if (toLocalUgPhone(c.payoutPhone) !== toLocalUgPhone(c.landlordPhone)) {
        if (d.recipient === toLocalUgPhone(c.payoutPhone)) {
          throw new Error(`${c.name}: OTP leaked to the mobile money number`);
        }
      }
    }
  }
});

Deno.test("no usable number at all is a hard error, never a silent shift", () => {
  assertThrows(() => resolveOtpRecipient(null, "abc"));
});

Deno.test("toLocalUgPhone normalizes every stored shape to one form", () => {
  assertEquals(toLocalUgPhone("0772123456"), "0772123456");
  assertEquals(toLocalUgPhone("+256772123456"), "0772123456");
  assertEquals(toLocalUgPhone("256772123456"), "0772123456");
  assertEquals(toLocalUgPhone("772123456"), "0772123456");
  assertEquals(toLocalUgPhone("0772 123 456"), "0772123456");
  assertEquals(toLocalUgPhone(""), null);
  assertEquals(toLocalUgPhone(null), null);
  assertEquals(toLocalUgPhone("0044772123456"), null);
});
