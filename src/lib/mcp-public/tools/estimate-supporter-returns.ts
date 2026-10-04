import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { buildSignupLinks } from "../links";
import { enforceRateLimit } from "../rateLimit";
import { publicToolResult, spanRange, pointRange, ugx, type EstimateRange } from "../response";

// PUBLIC, no-auth tool. Gives a prospective Supporter an ILLUSTRATIVE returns
// range in UGX for a chosen support amount and duration, then hands back the
// free Supporter signup link. It mirrors the in-app InvestmentCalculator math
// (15% monthly platform rewards), showing a range from simple (non-reinvested)
// to compounding (rewards reinvested each month) so the figure is honest, not a
// single hero number. Nothing here is a guarantee — rates and terms are shown
// in the app after signup. (Terminology: Supporter, not lender; Returns, not
// interest.)
//
// Mirrors src/components/supporter/InvestmentCalculator.tsx:
//   REWARD_RATE = 0.15 (15% monthly)
//   simple:   monthlyReward = amount * 0.15; total = monthlyReward * months
//   compound: each month balance += balance * 0.15

const REWARD_RATE = 0.15;
const DEFAULT_DURATIONS = [3, 6, 12] as const;

// Guard rails for a compliance-safe, sensible illustration (UGX).
const MIN_AMOUNT = 20_000; // matches the platform's minimum share/support size
const MAX_AMOUNT = 500_000_000;
const MIN_MONTHS = 1;
const MAX_MONTHS = 36;

function project(amount: number, months: number) {
  // Simple: rewards paid out, not reinvested.
  const monthlyReward = amount * REWARD_RATE;
  const simpleEarnings = monthlyReward * months;
  const simpleTotal = amount + simpleEarnings;

  // Compound: rewards reinvested each month.
  let balance = amount;
  for (let m = 1; m <= months; m++) balance += balance * REWARD_RATE;
  const compoundEarnings = balance - amount;

  return {
    durationMonths: months,
    monthlyReward: Math.round(monthlyReward),
    simpleEarnings: Math.round(simpleEarnings),
    simpleTotal: Math.round(simpleTotal),
    compoundEarnings: Math.round(compoundEarnings),
    compoundTotal: Math.round(balance),
  };
}

export default defineTool({
  name: "estimate_supporter_returns",
  title: "Estimate Supporter Returns (illustrative)",
  description:
    "Give a prospective Supporter an ILLUSTRATIVE Returns range in UGX for a chosen support amount over time (based on 15% monthly platform rewards), then return the free Supporter signup link. No sign-in required. The range spans simple (rewards paid out) to compounding (rewards reinvested) — it is an illustration only, not a guarantee; actual rates and terms are shown in the app after signup. Provide `amount` (UGX to support). Optionally provide `duration_months` (1-36) for one horizon, otherwise 3/6/12-month options are returned. Optional `referral_code` adds a referral signup link. (Terminology: Supporter, not lender; Returns, not interest.)",
  inputSchema: {
    amount: z
      .number()
      .describe("Amount to support in UGX (e.g. 500000). Illustration only."),
    duration_months: z
      .number()
      .describe("Optional horizon in months (1-36). Omit to compare 3/6/12-month options.")
      .optional(),
    referral_code: z
      .string()
      .describe("Optional referral code (the referrer's Welile user id) to build a referral signup link.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ amount, duration_months, referral_code }) => {
    const limited = await enforceRateLimit("estimate_supporter_returns");
    if (limited) return limited;

    const { signupUrl, referralUrl, landingUrl } = buildSignupLinks({
      referralCode: referral_code,
      role: "supporter",
    });
    const links = { landing_url: landingUrl, signup_url: signupUrl, referral_url: referralUrl, role: "supporter" };

    if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      return publicToolResult({
        tool: "estimate_supporter_returns",
        summary: `Please share a support amount between ${ugx(MIN_AMOUNT)} and ${ugx(MAX_AMOUNT)} for an illustrative estimate.`,
        next_steps: [`Ask again with an amount in UGX, for example ${ugx(500_000)}.`],
        links,
        error: {
          code: "invalid_amount",
          message: `Support amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} UGX.`,
          details: { min_amount: MIN_AMOUNT, max_amount: MAX_AMOUNT },
        },
      });
    }

    const roundedAmount = Math.round(amount);

    let months: number[];
    if (duration_months != null) {
      const m = Math.round(duration_months);
      if (!Number.isFinite(m) || m < MIN_MONTHS || m > MAX_MONTHS) {
        return publicToolResult({
          tool: "estimate_supporter_returns",
          summary: `Horizon must be between ${MIN_MONTHS} and ${MAX_MONTHS} months. Try 3, 6, or 12 months.`,
          next_steps: ["Ask again with a horizon of 3, 6, or 12 months."],
          links,
          error: {
            code: "invalid_duration",
            message: `Horizon must be between ${MIN_MONTHS} and ${MAX_MONTHS} months.`,
            details: { min_months: MIN_MONTHS, max_months: MAX_MONTHS },
          },
        });
      }
      months = [m];
    } else {
      months = [...DEFAULT_DURATIONS];
    }

    const projections = months.map((m) => project(roundedAmount, m));

    const lines = projections
      .map(
        (p) =>
          `• ${p.durationMonths} month${p.durationMonths === 1 ? "" : "s"}: Returns of ${ugx(p.simpleEarnings)} (paid out) to ${ugx(p.compoundEarnings)} (reinvested)`,
      )
      .join("\n");

    // Normalised ranges: Returns (and the resulting balance) as a genuine
    // low→high span per horizon — low = rewards paid out, high = reinvested.
    const ranges: EstimateRange[] = [];
    for (const p of projections) {
      const period = { unit: "months" as const, value: p.durationMonths };
      ranges.push(
        spanRange(`Returns over ${p.durationMonths} month${p.durationMonths === 1 ? "" : "s"}`, "returns", p.simpleEarnings, p.compoundEarnings, "UGX", period, {
          paid_out: p.simpleEarnings,
          reinvested: p.compoundEarnings,
        }),
        spanRange(`Total value after ${p.durationMonths} month${p.durationMonths === 1 ? "" : "s"}`, "total_value", p.simpleTotal, p.compoundTotal, "UGX", period, {
          principal: roundedAmount,
          paid_out_total: p.simpleTotal,
          reinvested_total: p.compoundTotal,
        }),
        pointRange("Monthly reward (first month)", "monthly_reward", p.monthlyReward, "UGX_per_month", period),
      );
    }

    const allReturns = projections.flatMap((p) => [p.simpleEarnings, p.compoundEarnings]);

    return publicToolResult({
      tool: "estimate_supporter_returns",
      kind: "estimate",
      summary: `Illustrative Returns for supporting ${ugx(roundedAmount)}: ${ugx(Math.min(...allReturns))}–${ugx(
        Math.max(...allReturns),
      )} depending on horizon and whether Returns are paid out or reinvested.`,
      body: [lines],
      assumptions: [
        `Platform rewards of ${REWARD_RATE * 100}% a month on the supported amount.`,
        "Low end of each range = Returns paid out monthly; high end = Returns reinvested (compounding).",
        projections.length > 1
          ? `No horizon was given, so ${DEFAULT_DURATIONS.join("/")}-month options are compared.`
          : `Horizon of ${projections[0].durationMonths} month${projections[0].durationMonths === 1 ? "" : "s"} as requested.`,
        "Principal is assumed to stay in place for the whole horizon, with no withdrawal.",
      ],
      estimates: {
        basis: `${REWARD_RATE * 100}% monthly platform rewards, shown both paid out (simple) and reinvested (compounding).`,
        confidence: "illustrative",
        currency: "UGX",
        ranges,
      },
      data: {
        amount: roundedAmount,
        monthly_reward_rate_pct: REWARD_RATE * 100,
        projections: projections.map((p) => ({
          duration_months: p.durationMonths,
          monthly_reward: p.monthlyReward,
          simple_earnings: p.simpleEarnings,
          simple_total: p.simpleTotal,
          compound_earnings: p.compoundEarnings,
          compound_total: p.compoundTotal,
        })),
      },
      disclaimers: [
        "This is an illustration only — not a guarantee of Returns.",
        "Actual rates and terms are shown in the app after you create a free account.",
        "Supporter withdrawals require a 90-day notice period.",
      ],
      next_steps: [
        "Create a free Supporter account to view current Returns and start supporting tenants.",
      ],
      links,
    });
  },
});