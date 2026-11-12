import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canSelfPayLandlords } from "./landlordSelfPayAgents.ts";
Deno.test("only Alpha Ssema may self-pay landlords", () => {
  assertEquals(canSelfPayLandlords("9188db01-e54a-4f84-8de9-042e6b5b6bd6"), true);
  assertEquals(canSelfPayLandlords("6a5abd4f-6527-45f9-b9fa-bdc489186b2c"), false);
  assertEquals(canSelfPayLandlords(null), false);
});
