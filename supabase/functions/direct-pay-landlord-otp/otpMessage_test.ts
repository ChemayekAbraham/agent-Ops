/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { redactSmsCodes } from "../_shared/redactSmsCodes.ts";
import { landlordOtpMessage, maskPhone } from "./otpMessage.ts";

Deno.test("the landlord SMS names the amount and the tenant", () => {
  assertEquals(landlordOtpMessage({ otp: "482913", amount: 500000, tenantFirstName: "Musa" }),
    "WELILE code: 482913. Read it only to the Welile officer on the phone, to confirm you received UGX 500,000 rent for Musa.");
});

Deno.test("the SMS log never keeps the code (redactSmsCodes recognises the wording)", () => {
  const logged = redactSmsCodes(landlordOtpMessage({ otp: "482913", amount: 500000, tenantFirstName: "Musa" })) ?? "";
  assert(!logged.includes("482913"), logged);
  assert(logged.includes("UGX 500,000"), logged);
});

Deno.test("no tenant name falls back politely", () => {
  assert(landlordOtpMessage({ otp: "000001", amount: 1, tenantFirstName: null }).endsWith("rent for your tenant."));
});

Deno.test("the officer only sees the last three digits", () => {
  assertEquals(maskPhone("+256 772 123456"), "***456");
  assertEquals(maskPhone(""), "***");
});
