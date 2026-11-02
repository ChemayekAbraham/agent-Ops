import { z } from "https://esm.sh/zod@3.23.8";

/**
 * Rent Plan calculator. Pure arithmetic on the numbers the agent typed: it reads no account data
 * and calls no database, so it is safe for anyone signed in. The formula mirrors
 * src/lib/rentCalculations.ts (calculateRentRepayment), which mirrors compute_rent_repayment() in
 * the database. Keep the three in step; the database is authoritative.
 */

export const CALC_TOOL_NAME = "calculate_rent_plan";

const MONTHLY_RATES = [0.23, 0.28, 0.33] as const;
const MIN_DAYS = 7;
const MAX_DAYS = 120;

export const CALC_TOOL = {
  name: CALC_TOOL_NAME,
  description:
    "Work out a Rent Plan from numbers the agent gives you: the rent amount and how many days it will be repaid over. " +
    "Returns the access fee, request fee, total repayment and daily repayment. Use this for any 'how much would a Rent Plan " +
    "cost / what is the daily amount' question; never do this arithmetic yourself. Needs no account data.",
  parameters: {
    type: "object",
    properties: {
      rent_amount: { type: "integer", minimum: 50000, maximum: 20000000, description: "Rent in UGX." },
      duration_days: { type: "integer", minimum: MIN_DAYS, maximum: MAX_DAYS, description: "Repayment period in days (7 to 120)." },
      monthly_rate: { type: "number", enum: [...MONTHLY_RATES], description: "Optional monthly access fee rate. Default 0.33." },
    },
    required: ["rent_amount", "duration_days"],
    additionalProperties: false,
  },
  schema: z.object({
    rent_amount: z.number().int().min(50000).max(20000000),
    duration_days: z.number().int().min(MIN_DAYS).max(MAX_DAYS),
    monthly_rate: z.union([z.literal(0.23), z.literal(0.28), z.literal(0.33)]).optional(),
  }).strict(),
} as const;

export interface RentPlanCalc {
  rent_amount: number;
  duration_days: number;
  monthly_rate: number;
  access_fee: number;
  request_fee: number;
  total_repayment: number;
  daily_repayment: number;
}

function requestFee(rent: number): number {
  return rent <= 200000 ? 10000 : 20000;
}

export function calculateRentPlan(rent: number, days: number, monthlyRate = 0.33): RentPlanCalc {
  const curveFee = Math.round(rent * (Math.pow(1 + monthlyRate, days / 30) - 1));
  const reqFee = requestFee(rent);
  // BD-4 floor: below roughly 24 days the curve does not cover agent commission plus partner reward.
  const floor = Math.ceil((rent * (0.005 * days + 0.10) + 0.10 * reqFee) / 0.90);
  const accessFee = Math.max(curveFee, floor);
  const total = rent + accessFee + reqFee;
  return {
    rent_amount: rent,
    duration_days: days,
    monthly_rate: monthlyRate,
    access_fee: accessFee,
    request_fee: reqFee,
    total_repayment: total,
    daily_repayment: Math.ceil(total / days),
  };
}

/** Same row the model gets from a data tool, so the output guard can match every figure it quotes. */
export function runCalcTool(args: z.infer<typeof CALC_TOOL.schema>): RentPlanCalc {
  return calculateRentPlan(args.rent_amount, args.duration_days, args.monthly_rate ?? 0.33);
}
