import { defineTool } from "@lovable.dev/mcp-js";
import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "get_my_wallet",
  title: "Get my wallet balance",
  description:
    "Return the signed-in user's Welile wallet: withdrawable balance (the amount they can withdraw) plus float and advance buckets. Amounts are in UGX.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const userId = ctx.getUserId();

    const { data: available, error: rpcError } = await supabase.rpc(
      "get_user_available_balance",
      { p_user_id: userId },
    );
    if (rpcError) return { content: [{ type: "text", text: rpcError.message }], isError: true };

    const { data: wallet } = await supabase
      .from("wallets")
      .select("float_balance, advance_balance, currency")
      .eq("user_id", userId)
      .maybeSingle();

    const result = {
      currency: "UGX",
      withdrawable_balance: Number(available ?? 0),
      float_balance: Number(wallet?.float_balance ?? 0),
      advance_balance: Number(wallet?.advance_balance ?? 0),
    };
    return {
      content: [
        {
          type: "text",
          text: `Withdrawable: UGX ${result.withdrawable_balance.toLocaleString()} | Float: UGX ${result.float_balance.toLocaleString()} | Advance: UGX ${result.advance_balance.toLocaleString()}`,
        },
      ],
      structuredContent: { wallet: result },
    };
  },
});