/**
 * Requisition → weekly budget line (migration 20261020200000_requisition_budget_line_reference).
 *
 * The database trigger trg_requisition_budget_line_guard is the authority: it decides whether a
 * budget line is required and whether the chosen one is valid (on the CFO dashboard, this week's
 * call, own department, within the line's submitted amount). It raises `CODE: message`. This module
 * only turns that into a 4xx answer the requester can act on, instead of a 500.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BUDGET_LINE_CODES = [
  "BUDGET_LINE_REQUIRED",
  "BUDGET_LINE_NOT_FOUND",
  "BUDGET_LINE_REJECTED",
  "BUDGET_NOT_ON_CFO_DASHBOARD",
  "BUDGET_LINE_WRONG_WEEK",
  "BUDGET_LINE_OTHER_DEPARTMENT",
  "BUDGET_LINE_OVER_BUDGET",
  "BUDGET_LINE_LOCKED",
] as const;

export type BudgetLineCode = (typeof BUDGET_LINE_CODES)[number];

/** Parses a trigger/evaluation error message into its code and the human sentence after it. */
export function parseBudgetLineError(message: string | null | undefined): { code: BudgetLineCode; message: string } | null {
  if (!message) return null;
  const m = /(BUDGET_LINE_[A-Z_]+|BUDGET_NOT_ON_CFO_DASHBOARD):\s*([^\n]*)/.exec(message);
  if (!m || !(BUDGET_LINE_CODES as readonly string[]).includes(m[1])) return null;
  return { code: m[1] as BudgetLineCode, message: m[2].trim() };
}

/**
 * Builds the response for a rejected budget line, or returns null when the error is something else.
 * Over-budget is a 409 (the line is valid but full); every other rule is a 400.
 */
export function budgetLineRejectionResponse(
  message: string | null | undefined,
  respond: (body: unknown, status: number) => Response,
): Response | null {
  const parsed = parseBudgetLineError(message);
  if (!parsed) return null;
  return respond({ error: parsed.message, code: parsed.code }, parsed.code === "BUDGET_LINE_OVER_BUDGET" ? 409 : 400);
}
