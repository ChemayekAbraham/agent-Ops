// ============================================================================
// Shared response envelope for every PUBLIC (no-auth) Welile MCP tool.
//
// Assistants (ChatGPT, Claude) read `structuredContent` to reason and the text
// block to speak. Before this module each tool invented its own field names, so
// a model had to guess where the answer lived. Every public tool now returns the
// SAME top-level shape, so a caller can rely on:
//
//   summary      — one sentence answering the question
//   assumptions  — what the numbers assume (rates, defaults, filters applied)
//   estimates    — normalised ranges: metric, low, high, unit, period
//   data         — the tool-specific payload (faqs, plans, listings…)
//   disclaimers  — compliance-safe caveats (never an approval or guarantee)
//   next_steps   — what the user should do next
//   links        — landing / signup / referral URLs and the target role
//   error        — null on success, else { code, message, retry_after_seconds }
//
// `ok`, `kind`, `currency` and `schema_version` are always present, on success
// AND on failure, so a client never has to branch on shape — only on `ok`.
// ============================================================================

export const PUBLIC_TOOL_SCHEMA_VERSION = "1.0" as const;

/** Every public tool deals strictly in Ugandan Shillings. */
export const CURRENCY = "UGX" as const;

export type PublicToolKind = "info" | "estimate" | "listings" | "error";

/**
 * How much weight a caller may put on the numbers.
 *  - indicative   → a real formula, but not a personal approval (rent access)
 *  - illustrative → a projection/scenario, not a promised rate (Returns)
 *  - actual       → live records read from the database (house listings)
 */
export type EstimateConfidence = "indicative" | "illustrative" | "actual";

export type EstimateUnit = "UGX" | "UGX_per_day" | "UGX_per_month" | "count";

/**
 * One normalised range. `low` and `high` are always both present: when a figure
 * is a single number they are equal, so a caller never special-cases a scalar.
 */
export type EstimateRange = {
  /** Human label, e.g. "60-day plan total". */
  label: string;
  /** Stable machine key, e.g. "total_repayment", "returns". */
  metric: string;
  unit: EstimateUnit;
  low: number;
  high: number;
  /** The horizon this range covers, when it has one. */
  period: { unit: "days" | "months"; value: number } | null;
  /** Optional line items; keys are stable snake_case metric names. */
  breakdown: Record<string, number> | null;
};

export type Estimates = {
  /** Plain-English description of the formula/source behind the ranges. */
  basis: string;
  confidence: EstimateConfidence;
  currency: typeof CURRENCY;
  ranges: EstimateRange[];
};

export type PublicToolLinks = {
  landing_url: string;
  signup_url: string;
  referral_url: string | null;
  /** Signup path the links target ("tenant", "agent", …) when role-specific. */
  role: string | null;
};

export type PublicToolError = {
  code: string;
  message: string;
  retry_after_seconds: number | null;
  details: Record<string, unknown> | null;
};

export type PublicToolEnvelope = {
  schema_version: typeof PUBLIC_TOOL_SCHEMA_VERSION;
  tool: string;
  ok: boolean;
  kind: PublicToolKind;
  summary: string;
  assumptions: string[];
  estimates: Estimates | null;
  data: Record<string, unknown>;
  disclaimers: string[];
  next_steps: string[];
  links: PublicToolLinks;
  currency: typeof CURRENCY;
  error: PublicToolError | null;
};

/** Shape the MCP SDK expects back from a tool handler. */
export type PublicToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: PublicToolEnvelope;
  isError?: boolean;
};

const FALLBACK_LINKS: PublicToolLinks = {
  landing_url: "https://welileapp.com",
  signup_url: "https://welileapp.com/auth",
  referral_url: null,
  role: null,
};

export type BuildArgs = {
  tool: string;
  kind?: PublicToolKind;
  summary: string;
  /** Pre-rendered body lines for the spoken text (tables, bullet lists…). */
  body?: string[];
  assumptions?: string[];
  estimates?: Estimates | null;
  data?: Record<string, unknown>;
  disclaimers?: string[];
  next_steps?: string[];
  links?: Partial<PublicToolLinks>;
  error?: Partial<PublicToolError> & { code: string; message: string };
};

function renderText(e: PublicToolEnvelope, body: string[]): string {
  const blocks: string[] = [e.summary];

  const trimmedBody = body.filter((b) => b != null && b !== "");
  if (trimmedBody.length) blocks.push(trimmedBody.join("\n"));

  if (e.assumptions.length) {
    blocks.push(`Assumptions:\n${e.assumptions.map((a) => `• ${a}`).join("\n")}`);
  }
  if (e.disclaimers.length) blocks.push(e.disclaimers.join(" "));
  if (e.next_steps.length) {
    blocks.push(`Next step${e.next_steps.length === 1 ? "" : "s"}:\n${e.next_steps.map((s) => `• ${s}`).join("\n")}`);
  }

  const links = [
    `Start here (guided onboarding): ${e.links.landing_url}`,
    `Create a free account: ${e.links.signup_url}`,
    e.links.referral_url ? `Referral signup link: ${e.links.referral_url}` : null,
  ].filter(Boolean) as string[];
  blocks.push(links.join("\n"));

  return blocks.join("\n\n");
}

/**
 * Build a standardised public-tool result. Use for BOTH success and failure —
 * pass `error` to mark a failure (sets ok:false, kind:"error", isError:true).
 */
export function publicToolResult(args: BuildArgs): PublicToolResult {
  const error: PublicToolError | null = args.error
    ? {
        code: args.error.code,
        message: args.error.message,
        retry_after_seconds: args.error.retry_after_seconds ?? null,
        details: args.error.details ?? null,
      }
    : null;

  const envelope: PublicToolEnvelope = {
    schema_version: PUBLIC_TOOL_SCHEMA_VERSION,
    tool: args.tool,
    ok: !error,
    kind: error ? "error" : (args.kind ?? "info"),
    summary: args.summary,
    assumptions: args.assumptions ?? [],
    estimates: args.estimates ?? null,
    data: args.data ?? {},
    disclaimers: args.disclaimers ?? [],
    next_steps: args.next_steps ?? [],
    links: { ...FALLBACK_LINKS, ...(args.links ?? {}) },
    currency: CURRENCY,
    error,
  };

  const result: PublicToolResult = {
    content: [{ type: "text", text: renderText(envelope, args.body ?? []) }],
    structuredContent: envelope,
  };
  if (error) result.isError = true;
  return result;
}

/** Format a UGX amount for the spoken text. */
export const ugx = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "UGX —" : `UGX ${Math.round(n).toLocaleString("en-US")}`;

/** A range whose low and high are the same figure. */
export function pointRange(
  label: string,
  metric: string,
  value: number,
  unit: EstimateUnit = CURRENCY,
  period: EstimateRange["period"] = null,
  breakdown: EstimateRange["breakdown"] = null,
): EstimateRange {
  return { label, metric, unit, low: Math.round(value), high: Math.round(value), period, breakdown };
}

/** A true low→high range (order-safe). */
export function spanRange(
  label: string,
  metric: string,
  low: number,
  high: number,
  unit: EstimateUnit = CURRENCY,
  period: EstimateRange["period"] = null,
  breakdown: EstimateRange["breakdown"] = null,
): EstimateRange {
  return {
    label,
    metric,
    unit,
    low: Math.round(Math.min(low, high)),
    high: Math.round(Math.max(low, high)),
    period,
    breakdown,
  };
}
