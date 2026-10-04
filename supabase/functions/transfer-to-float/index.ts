import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * transfer-to-float
 * ─────────────────────────────────────────────────────────────────────
 * Backend-only intra-wallet transfer that moves funds from an agent's
 * `withdrawable_balance` into their `float_balance`.
 *
 * STRICT BACKEND-AUTHORITY CONTRACT:
 *   • Caller sends ONLY { amount }. No user_id, no balance, no routing.
 *   • Backend authenticates the caller via JWT.
 *   • Backend authorizes: caller MUST hold the `agent` role.
 *   • Backend validates: caller's withdrawable balance MUST cover amount.
 *   • Backend issues ONE balanced wallet-scope ledger pair:
 *        cash_out  wallet_deduction    → drains withdrawable
 *        cash_in   agent_float_deposit → credits float
 *   • Wallet bucket fields are updated by tr_general_ledger_route_buckets,
 *     never by this function. Frontend never mutates either bucket.
 *   • UI updates ONLY via the realtime `wallets` subscription.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ── AuthN ──────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Input validation (BACKEND ONLY) ────────────────────────────
    const body = await req.json().catch(() => ({}));
    const rawAmount = (body as { amount?: unknown }).amount;
    const amount = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return new Response(
        JSON.stringify({ error: "INVALID_AMOUNT", message: "Amount must be a positive number." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (amount > 1_000_000_000) {
      return new Response(
        JSON.stringify({ error: "AMOUNT_TOO_LARGE", message: "Amount exceeds permitted maximum." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // ── AuthZ: caller MUST hold the `agent` role ───────────────────
    const { data: agentRoleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "agent")
      .maybeSingle();

    if (!agentRoleRow) {
      return new Response(
        JSON.stringify({
          error: "FORBIDDEN",
          message: "Only agents can transfer funds to operational float.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Backend balance check ──────────────────────────────────────
    // Read the wallet's withdrawable bucket directly. The frontend never
    // sees, sends, or compares this number.
    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from("wallets")
      .select("withdrawable_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (walletErr) {
      console.error("[transfer-to-float] wallet lookup failed:", walletErr);
      return new Response(
        JSON.stringify({ error: "WALLET_LOOKUP_FAILED", message: walletErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const withdrawable = Number(wallet?.withdrawable_balance ?? 0);
    if (withdrawable < amount) {
      return new Response(
        JSON.stringify({
          error: "INSUFFICIENT_WITHDRAWABLE",
          message: `Withdrawable balance (UGX ${withdrawable.toLocaleString()}) is less than requested transfer (UGX ${amount.toLocaleString()}).`,
          available: withdrawable,
          requested: amount,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Atomic balanced ledger pair (intra-wallet transfer) ────────
    // Both legs are wallet-scope on the SAME user. The route function
    // sends the cash_out leg to the withdrawable bucket and the cash_in
    // leg to the float bucket — the wallet update happens entirely
    // inside the tr_general_ledger_route_buckets trigger.
    const transferRef = `float-transfer-${user.id}-${Date.now()}`;
    const { data: txGroupId, error: ledgerErr } = await supabaseAdmin.rpc(
      "create_ledger_transaction",
      {
        entries: [
          {
            user_id: user.id,
            amount,
            direction: "cash_out",
            category: "wallet_deduction",
            ledger_scope: "wallet",
            source_table: "agent_float_funding",
            reference_id: transferRef,
            description: "Agent self-service: move funds from withdrawable to operational float",
            currency: "UGX",
            transaction_date: new Date().toISOString(),
          },
          {
            user_id: user.id,
            amount,
            direction: "cash_in",
            category: "agent_float_deposit",
            ledger_scope: "wallet",
            source_table: "agent_float_funding",
            reference_id: transferRef,
            description: "Agent self-service: credit operational float bucket",
            currency: "UGX",
            transaction_date: new Date().toISOString(),
          },
        ],
        idempotency_key: transferRef,
      },
    );

    if (ledgerErr) {
      console.error("[transfer-to-float] ledger RPC failed:", ledgerErr);
      return new Response(
        JSON.stringify({
          error: "LEDGER_FAILED",
          message: ledgerErr.message ?? "Ledger transaction failed.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Operational mirror row for reporting / reconciliation ──────
    const { data: fundingRow, error: fundingErr } = await supabaseAdmin
      .from("agent_float_funding")
      .insert({
        agent_id: user.id,
        amount,
        status: "approved",
        funded_by: user.id,
        bank_reference: transferRef,
        bank_name: "internal_transfer",
        notes: `Agent self-service intra-wallet transfer (group ${txGroupId})`,
      })
      .select("id")
      .maybeSingle();

    if (fundingErr) {
      // Non-fatal — the ledger pair already balanced and the wallet
      // buckets already moved. Log loudly so ops can backfill the row.
      console.error("[transfer-to-float] mirror insert failed:", fundingErr);
    }

    // ── Audit ──────────────────────────────────────────────────────
    await supabaseAdmin.from("audit_logs").insert({
      user_id: user.id,
      action_type: "agent_float_self_transfer",
      table_name: "wallets",
      record_id: user.id,
      metadata: {
        amount,
        from_bucket: "withdrawable_balance",
        to_bucket: "float_balance",
        transaction_group_id: txGroupId,
        funding_row_id: fundingRow?.id ?? null,
        withdrawable_before: withdrawable,
        withdrawable_after: withdrawable - amount,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        transaction_group_id: txGroupId,
        amount,
        moved_from: "withdrawable_balance",
        moved_to: "float_balance",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[transfer-to-float] unexpected error:", message);
    return new Response(
      JSON.stringify({ error: "INTERNAL_ERROR", message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
