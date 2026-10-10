import { z } from "https://esm.sh/zod@3.23.8";
import { ISO_DATE, kampalaToday, PERIODS, resolvePeriod } from "./dates.ts";

/**
 * Tool registry for the AGENT persona. This is the only thing that decides what the model can
 * ask for. Adding a capability = one read-only `assistant_agent_*` RPC + one entry here.
 *
 * Invariants (enforced again by scripts/guard-assistant-readonly.mjs at build time):
 *   - every `rpc` is an `assistant_agent_*` function (STABLE, identity from auth.uid());
 *   - no tool takes a user / agent / tenant id of any kind;
 *   - arguments are enums and dates only, validated with zod before anything runs.
 */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema sent to the model. */
  parameters: Record<string, unknown>;
  /** Server-side validation; the model's arguments are untrusted. */
  schema: z.ZodType<Record<string, unknown>>;
  /** Postgres function this tool calls, as the signed-in user. */
  rpc: string;
  /** Map validated arguments to the RPC's named parameters. */
  toRpcArgs: (args: Record<string, unknown>) => Record<string, unknown>;
}

const date = z.string().regex(ISO_DATE);
const period = z.enum(PERIODS);

const rangeShape = {
  period: period.optional(),
  from: date.optional(),
  to: date.optional(),
};
const noPeriodAndDates = (a: { period?: unknown; from?: unknown; to?: unknown }) =>
  !(a.period && (a.from || a.to));
const RANGE_CONFLICT = { message: "use either period or from/to, not both" };

const rangeSchema = z.object(rangeShape).strict().refine(noPeriodAndDates, RANGE_CONFLICT);

const rangeProps = {
  period: {
    type: "string",
    enum: [...PERIODS],
    description:
      "A named period. Prefer this over from/to. Weeks start Monday. Omit for today.",
  },
  from: { type: "string", description: "Start date YYYY-MM-DD (only if no named period fits)." },
  to: { type: "string", description: "End date YYYY-MM-DD, inclusive." },
};

type Range = z.infer<typeof rangeSchema>;

function rangeToRpc(a: Range, defaultPeriod: "today" | "last_7_days"): { p_from: string; p_to: string } {
  if (a.from || a.to) {
    const to = a.to ?? kampalaToday();
    return { p_from: a.from ?? to, p_to: to };
  }
  const r = resolvePeriod(a.period ?? defaultPeriod);
  return { p_from: r.from, p_to: r.to };
}

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "get_wallet",
    description:
      "The agent's own wallet right now: wallet_balance, withdrawable_balance (can be withdrawn), " +
      "float_balance (company float available to collect with), advance_balance, locked_balance, and " +
      "landlord_float_available (landlord-payout float they can still spend). Use for any 'how much do I have' question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    rpc: "assistant_agent_wallet",
    toRpcArgs: () => ({}),
  },
  {
    name: "get_wallet_transactions",
    description:
      "The agent's own wallet movements (money in / money out) with category, amount and date. " +
      "Returns totals for the whole range and up to `limit` of the most recent items. Max range 92 days.",
    parameters: {
      type: "object",
      properties: {
        ...rangeProps,
        direction: { type: "string", enum: ["in", "out"], description: "Only money in, or only money out." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many recent items to list (default 20)." },
      },
      additionalProperties: false,
    },
    schema: z.object({
      ...rangeShape,
      direction: z.enum(["in", "out"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).strict().refine(noPeriodAndDates, RANGE_CONFLICT) as unknown as z.ZodType<Record<string, unknown>>,
    rpc: "assistant_agent_wallet_transactions",
    toRpcArgs: (a) => {
      const r = a as Range & { direction?: "in" | "out"; limit?: number };
      return { ...rangeToRpc(r, "last_7_days"), p_direction: r.direction ?? null, p_limit: r.limit ?? 20 };
    },
  },
  {
    name: "get_collections_summary",
    description:
      "How much the agent collected over a period, how many collections and tenants paid, the amount " +
      "expected (the pinned daily bill), and remaining_on_billed_plans (still unpaid on the days' bills). " +
      "Use for 'how much have I collected' and 'what is remaining to collect'. 'Remaining' here is only against " +
      "the daily bill for the period asked, NOT each tenant's whole Rent Plan balance. Max range 92 days.",
    parameters: { type: "object", properties: rangeProps, additionalProperties: false },
    schema: rangeSchema as unknown as z.ZodType<Record<string, unknown>>,
    rpc: "assistant_agent_collections_summary",
    toRpcArgs: (a) => rangeToRpc(a as Range, "today"),
  },
  {
    name: "get_collection_day_detail",
    description:
      "One day's collection facts to explain why it was high or low: expected vs collected, how many Rent Plans " +
      "were billed and how many were paid in full / partly / not at all, the largest shortfalls, and the agent's " +
      "own trailing 7-day averages. Explain ONLY from these facts.",
    parameters: {
      type: "object",
      properties: {
        day: { type: "string", enum: ["today", "yesterday"], description: "Which day. Omit for today." },
        date: { type: "string", description: "A specific date YYYY-MM-DD (use instead of day)." },
      },
      additionalProperties: false,
    },
    schema: z.object({
      day: z.enum(["today", "yesterday"]).optional(),
      date: date.optional(),
    }).strict().refine((a) => !(a.day && a.date), { message: "use either day or date" }) as unknown as z.ZodType<
      Record<string, unknown>
    >,
    rpc: "assistant_agent_collection_day_detail",
    toRpcArgs: (a) => {
      const x = a as { day?: "today" | "yesterday"; date?: string };
      if (x.date) return { p_day: x.date };
      return { p_day: resolvePeriod(x.day === "yesterday" ? "yesterday" : "today").from };
    },
  },
  {
    name: "get_tenants",
    description:
      "Counts of the agent's tenants: tenants_linked (all), active_rent_plans, tenants_on_active_plans, " +
      "tenants_billed_today. Counts only, no personal details.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}).strict(),
    rpc: "assistant_agent_tenants",
    toRpcArgs: () => ({}),
  },
  {
    name: "get_advances",
    description:
      "The agent's own advances: principal, outstanding balance, arrears, installment, dates, whether deductions are " +
      "paused. status 'outstanding' = active or overdue (default); 'all' includes completed and cancelled.",
    parameters: {
      type: "object",
      properties: { status: { type: "string", enum: ["outstanding", "all"] } },
      additionalProperties: false,
    },
    schema: z.object({ status: z.enum(["outstanding", "all"]).optional() }).strict(),
    rpc: "assistant_agent_advances",
    toRpcArgs: (a) => ({ p_status: (a as { status?: string }).status ?? "outstanding" }),
  },
];

/** Handled by the edge function itself, never a database call. */
export const CLARIFICATION_TOOL = {
  name: "ask_clarification",
  description:
    "Use when the question could mean several different things or is missing what you need (for example 'how much do I owe'). " +
    "Ask ONE short question and offer 2-3 options the agent can tap.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", maxLength: 200 },
      options: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", maxLength: 60 } },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
  schema: z.object({
    question: z.string().min(1).max(200),
    options: z.array(z.string().min(1).max(60)).min(2).max(3),
  }).strict(),
} as const;

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** OpenAI-format tool list for the model. */
export function openAiTools() {
  return [
    ...AGENT_TOOLS.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    {
      type: "function" as const,
      function: {
        name: CLARIFICATION_TOOL.name,
        description: CLARIFICATION_TOOL.description,
        parameters: CLARIFICATION_TOOL.parameters,
      },
    },
  ];
}
