import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { buildStatement, statementTitle, ugx } from "../statement";

export default defineTool({
  name: "get_my_wallet_statement",
  title: "View my wallet statement",
  description:
    "Return the signed-in user's Welile wallet statement for an optional date range: every wallet ledger entry with money-in / money-out totals, net movement and the current withdrawable balance. Amounts are in UGX.",
  inputSchema: {
    from: z.string().describe("Optional start date, YYYY-MM-DD (inclusive).").optional(),
    to: z.string().describe("Optional end date, YYYY-MM-DD (inclusive).").optional(),
    limit: z
      .number()
      .int()
      .describe("Maximum number of entries to include. Defaults to 200; capped at 1000.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ from, to, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    try {
      const statement = await buildStatement(ctx, { from, to, limit });
      const header = [
        statementTitle(statement),
        `Entries: ${statement.rows.length}${statement.truncated ? " (truncated — narrow the date range)" : ""}`,
        `Money in: ${ugx(statement.total_in)} | Money out: ${ugx(statement.total_out)} | Net: ${ugx(statement.net_movement)}`,
        `Withdrawable balance now: ${ugx(statement.closing_withdrawable)}`,
        "",
      ];
      const lines = statement.rows.map(
        (r) =>
          `${r.date}  ${r.direction === "cash_in" ? "+" : "-"}${ugx(r.amount)}  ${r.category}` +
          (r.description ? `  — ${r.description}` : ""),
      );
      return {
        content: [
          { type: "text", text: [...header, ...(lines.length ? lines : ["No activity in this period."])].join("\n") },
        ],
        structuredContent: { statement },
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  },
});