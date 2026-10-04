import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from "../walletHistory";

export default defineTool({
  name: "list_my_transactions",
  title: "List my recent transactions",
  description:
    "List the signed-in user's most recent wallet ledger entries (deposits, withdrawals, commissions). Amounts are in UGX.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .describe("How many recent entries to return. Defaults to 20; capped at 100.")
      .optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const take = Math.min(Math.max(limit ?? 20, 1), 100);
    const { data, error } = await applyCustomerWalletLedgerFilters(supabaseForUser(ctx)
      .from("general_ledger")
      .select("id, created_at, category, direction, amount, description, wallet_bucket, classification, source_table, reference_id")
      .eq("user_id", ctx.getUserId())
      .eq("ledger_scope", "wallet"))
      .order("created_at", { ascending: false })
      .limit(take);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const rows = (data ?? []).filter(isCustomerWalletLedgerEntryVisible);
    const summary = rows
      .map(
        (r) =>
          `${new Date(r.created_at as string).toISOString().slice(0, 10)} · ${r.category} · ${r.direction} UGX ${Number(r.amount).toLocaleString()}`,
      )
      .join("\n");
    return {
      content: [{ type: "text", text: summary || "No transactions found." }],
      structuredContent: { transactions: rows },
    };
  },
});