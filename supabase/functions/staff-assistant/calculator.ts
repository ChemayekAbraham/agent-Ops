import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { extractNumbers } from "./guards.ts";

export const COMPUTE_OPERATIONS = [
  "sum",
  "difference",
  "pct_change",
  "share",
  "average",
  "rank",
] as const;

export type ComputeOperation = (typeof COMPUTE_OPERATIONS)[number];

const RankItemSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    value: z.number().finite(),
  })
  .strict();

export const ComputeArgsSchema = z
  .object({
    operation: z.enum(COMPUTE_OPERATIONS),
    label: z.string().trim().max(120).optional(),
    is_ugx: z.boolean().optional(),
    values: z.array(z.number().finite()).min(1).max(200).optional(),
    a: z.number().finite().optional(),
    b: z.number().finite().optional(),
    current: z.number().finite().optional(),
    previous: z.number().finite().optional(),
    part: z.number().finite().optional(),
    total: z.number().finite().optional(),
    items: z.array(RankItemSchema).min(1).max(200).optional(),
    order: z.enum(["desc", "asc"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export type ComputeArgs = z.infer<typeof ComputeArgsSchema>;

export const COMPUTE_OPENAI_TOOL = {
  type: "function" as const,
  function: {
    name: "compute",
    description:
      "Deterministic safe calculator (sum, difference, pct_change, share, average, rank). Works ONLY on figures already returned by tools in this conversation so period comparisons, totals, shares, and rankings are exact.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [...COMPUTE_OPERATIONS],
          description:
            "Operation to run: 'sum' (sum of values), 'difference' (a - b), 'pct_change' (((current - previous) / previous) * 100), 'share' ((part / total) * 100), 'average' (mean of values), or 'rank' (sort items by value).",
        },
        label: {
          type: "string",
          description: "Short label describing what is being calculated (e.g. 'Week-on-week collection change').",
        },
        is_ugx: {
          type: "boolean",
          description: "True when the input figures represent UGX money amounts.",
        },
        values: {
          type: "array",
          items: { type: "number" },
          description: "Numbers from tool results for 'sum' or 'average'.",
        },
        a: {
          type: "number",
          description: "First number from tool results for 'difference' (computes a - b).",
        },
        b: {
          type: "number",
          description: "Second number from tool results for 'difference' (computes a - b).",
        },
        current: {
          type: "number",
          description: "Current-period figure from tool results for 'pct_change'.",
        },
        previous: {
          type: "number",
          description: "Previous-period figure from tool results for 'pct_change'.",
        },
        part: {
          type: "number",
          description: "Numerator figure from tool results for 'share'.",
        },
        total: {
          type: "number",
          description: "Denominator figure from tool results for 'share'.",
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "number" },
            },
            required: ["label", "value"],
            additionalProperties: false,
          },
          description: "Labelled items from tool results for 'rank'.",
        },
        order: {
          type: "string",
          enum: ["desc", "asc"],
          description: "Sort order for 'rank' (default 'desc' = highest first).",
        },
        limit: {
          type: "number",
          description: "Optional top-N cap for 'rank' (1 to 50).",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
};

function normalizeNumToken(n: number): string[] {
  const tokens = [String(n), String(Math.round(n))];
  const r1 = Math.round(n * 10) / 10;
  const r2 = Math.round(n * 100) / 100;
  tokens.push(String(r1), String(r2));
  return tokens;
}

/**
 * Verifies that every numeric input passed to `compute` was already returned by a tool
 * in this conversation (`rawToolOutputs`, which includes current-turn tool results and
 * earlier conversation memory tool figures).
 */
export function areComputeInputsFromConversationTools(
  inputs: number[],
  rawToolOutputs: readonly string[],
): { ok: true } | { ok: false; missingValue: number } {
  if (inputs.length === 0) {
    return { ok: false, missingValue: NaN };
  }
  const allowed = extractNumbers(rawToolOutputs.join("\n"));
  for (const val of inputs) {
    if (!Number.isFinite(val)) {
      return { ok: false, missingValue: val };
    }
    const absVal = Math.abs(val);
    const matched = normalizeNumToken(absVal).some((tok) => allowed.has(tok));
    if (!matched) {
      return { ok: false, missingValue: val };
    }
  }
  return { ok: true };
}

function fmtUgx(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}UGX ${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

export type SafeComputeOutcome =
  | {
      ok: true;
      data: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Runs a deterministic calculation strictly over figures that already came from
 * tools in the current conversation.
 */
export function runSafeCompute(
  args: ComputeArgs,
  rawToolOutputs: readonly string[],
  periodLabel: string,
): SafeComputeOutcome {
  const op = args.operation;
  const isUgx = Boolean(args.is_ugx);
  const label = args.label ?? op;

  if (op === "sum") {
    const vals = args.values ?? [];
    if (vals.length === 0) {
      return { ok: false, error: "Provide non-empty `values` for operation='sum'." };
    }
    const check = areComputeInputsFromConversationTools(vals, rawToolOutputs);
    if (check.ok === false) {
      return {
        ok: false,
        error: `Input figure ${check.missingValue} was not returned by any tool in this conversation.`,
      };
    }
    const rawSum = vals.reduce((acc, v) => acc + v, 0);
    const sum = Math.round(rawSum * 100) / 100;
    return {
      ok: true,
      data: {
        source: "compute (Verified Conversation Calculator)",
        period: periodLabel,
        operation: "sum",
        label,
        count: vals.length,
        values: vals,
        sum,
        sum_rounded: Math.round(sum),
        ...(isUgx ? { formatted_sum: fmtUgx(sum) } : {}),
      },
    };
  }

  if (op === "difference") {
    const a = args.a ?? args.current;
    const b = args.b ?? args.previous;
    if (typeof a !== "number" || typeof b !== "number") {
      return { ok: false, error: "Provide `a` and `b` (or `current` and `previous`) for operation='difference'." };
    }
    const check = areComputeInputsFromConversationTools([a, b], rawToolOutputs);
    if (check.ok === false) {
      return {
        ok: false,
        error: `Input figure ${check.missingValue} was not returned by any tool in this conversation.`,
      };
    }
    const diff = Math.round((a - b) * 100) / 100;
    const absDiff = Math.abs(diff);
    return {
      ok: true,
      data: {
        source: "compute (Verified Conversation Calculator)",
        period: periodLabel,
        operation: "difference",
        label,
        a,
        b,
        difference: diff,
        absolute_difference: absDiff,
        direction: diff > 0 ? "increase" : diff < 0 ? "decrease" : "unchanged",
        ...(isUgx
          ? {
              formatted_a: fmtUgx(a),
              formatted_b: fmtUgx(b),
              formatted_difference: fmtUgx(diff),
              formatted_absolute_difference: fmtUgx(absDiff),
            }
          : {}),
      },
    };
  }

  if (op === "pct_change") {
    const current = args.current ?? args.a;
    const previous = args.previous ?? args.b;
    if (typeof current !== "number" || typeof previous !== "number") {
      return { ok: false, error: "Provide `current` and `previous` for operation='pct_change'." };
    }
    const check = areComputeInputsFromConversationTools([current, previous], rawToolOutputs);
    if (check.ok === false) {
      return {
        ok: false,
        error: `Input figure ${check.missingValue} was not returned by any tool in this conversation.`,
      };
    }
    const diff = Math.round((current - previous) * 100) / 100;
    const absDiff = Math.abs(diff);
    const pctChange =
      previous === 0 ? null : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
    const absPctChange = pctChange === null ? null : Math.abs(pctChange);
    return {
      ok: true,
      data: {
        source: "compute (Verified Conversation Calculator)",
        period: periodLabel,
        operation: "pct_change",
        label,
        current,
        previous,
        difference: diff,
        absolute_difference: absDiff,
        pct_change: pctChange,
        absolute_pct_change: absPctChange,
        formatted_pct_change: pctChange === null ? "N/A (previous is 0)" : `${pctChange}%`,
        direction: diff > 0 ? "increase" : diff < 0 ? "decrease" : "unchanged",
        ...(isUgx
          ? {
              formatted_current: fmtUgx(current),
              formatted_previous: fmtUgx(previous),
              formatted_difference: fmtUgx(diff),
              formatted_absolute_difference: fmtUgx(absDiff),
            }
          : {}),
      },
    };
  }

  if (op === "share") {
    const part = args.part ?? args.a;
    const total = args.total ?? args.b;
    if (typeof part !== "number" || typeof total !== "number") {
      return { ok: false, error: "Provide `part` and `total` for operation='share'." };
    }
    const check = areComputeInputsFromConversationTools([part, total], rawToolOutputs);
    if (check.ok === false) {
      return {
        ok: false,
        error: `Input figure ${check.missingValue} was not returned by any tool in this conversation.`,
      };
    }
    const sharePct = total === 0 ? null : Math.round((part / total) * 1000) / 10;
    const remainder = Math.round((total - part) * 100) / 100;
    return {
      ok: true,
      data: {
        source: "compute (Verified Conversation Calculator)",
        period: periodLabel,
        operation: "share",
        label,
        part,
        total,
        remainder,
        share_pct: sharePct,
        formatted_share_pct: sharePct === null ? "N/A (total is 0)" : `${sharePct}%`,
      },
    };
  }

  if (op === "average") {
    const vals = args.values ?? [];
    if (vals.length === 0) {
      return { ok: false, error: "Provide non-empty `values` for operation='average'." };
    }
    const check = areComputeInputsFromConversationTools(vals, rawToolOutputs);
    if (check.ok === false) {
      return {
        ok: false,
        error: `Input figure ${check.missingValue} was not returned by any tool in this conversation.`,
      };
    }
    const sum = vals.reduce((acc, v) => acc + v, 0);
    const avg = Math.round((sum / vals.length) * 100) / 100;
    const avgRounded = Math.round(avg);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return {
      ok: true,
      data: {
        source: "compute (Verified Conversation Calculator)",
        period: periodLabel,
        operation: "average",
        label,
        count: vals.length,
        sum: Math.round(sum * 100) / 100,
        average: avg,
        average_rounded: avgRounded,
        min,
        max,
        ...(isUgx ? { formatted_average: fmtUgx(avgRounded) } : {}),
      },
    };
  }

  if (op === "rank") {
    const items = args.items ?? [];
    if (items.length === 0) {
      return { ok: false, error: "Provide non-empty `items` for operation='rank'." };
    }
    const check = areComputeInputsFromConversationTools(
      items.map((i) => i.value),
      rawToolOutputs,
    );
    if (check.ok === false) {
      return {
        ok: false,
        error: `Input figure ${check.missingValue} was not returned by any tool in this conversation.`,
      };
    }
    const order = args.order ?? "desc";
    const sorted = [...items].sort((x, y) =>
      order === "asc" ? x.value - y.value : y.value - x.value,
    );
    const limited = args.limit ? sorted.slice(0, args.limit) : sorted;
    const total = items.reduce((acc, i) => acc + i.value, 0);
    const rows = limited.map((item, idx) => ({
      rank: idx + 1,
      label: item.label,
      value: item.value,
      share_pct: total > 0 ? Math.round((item.value / total) * 1000) / 10 : null,
      ...(isUgx ? { formatted_value: fmtUgx(item.value) } : {}),
    }));
    return {
      ok: true,
      data: {
        source: "compute (Verified Conversation Calculator)",
        period: periodLabel,
        operation: "rank",
        label,
        order,
        total: Math.round(total * 100) / 100,
        row_count: rows.length,
        rows,
      },
    };
  }

  return { ok: false, error: "Unsupported compute operation." };
}
