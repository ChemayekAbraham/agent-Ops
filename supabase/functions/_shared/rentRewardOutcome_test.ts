// classifyRentRewardPost: how process-supporter-roi acts on post_rent_facilitation_reward.
// Run: deno test supabase/functions/_shared/rentRewardOutcome_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyRentRewardPost } from "./rentRewardOutcome.ts";

Deno.test("a missing stored Returns rate defers the reward (logged), never an error or a guessed rate", () => {
  assertEquals(
    classifyRentRewardPost(null, { code: "55000", message: "RENT_REWARD_RATE_MISSING: no stored Returns rate for rent request x" }),
    { action: "defer", reason: "rate_missing" },
  );
});

Deno.test("existing outcomes are unchanged", () => {
  assertEquals(classifyRentRewardPost(null, { message: "PORTFOLIO_ON_HOLD" }), { action: "defer", reason: "reinvest_portfolio_on_hold" });
  assertEquals(classifyRentRewardPost(null, { message: "RENT_REWARD_REINVEST_TARGET_UNAVAILABLE: x" }), { action: "defer", reason: "reinvest_portfolio_unavailable" });
  assertEquals(classifyRentRewardPost(null, { message: "boom" }), { action: "error", reason: "boom" });
  assertEquals(classifyRentRewardPost({ status: "posted", amount: 15000, rate: 15 }, null), { action: "posted", reason: "posted" });
  assertEquals(classifyRentRewardPost({ status: "already_posted" }, null).action, "skip");
  assertEquals(classifyRentRewardPost({ status: "weird" }, null).action, "error");
});
