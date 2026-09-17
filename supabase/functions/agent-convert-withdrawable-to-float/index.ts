import { createClient } from "npm:@supabase/supabase-js@2";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { postBalancedLedgerGroup } from "../_shared/balancedLedgerPost.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/**
 * agent-convert-withdrawable-to-float
 *
 * Agent self-service: converts part of the agent's OWN withdrawable balance
 * into operational float they can spend on landlord payouts / tenant funding.
 *
 * The move is posted as ONE balanced wallet-scope double entry through
 * `create_ledger_transaction` (via postBalancedLedgerGroup), exactly the same
 * shape Financial Ops uses in `admin-withdrawable-to-float`:
 *   • leg 1: cash_out amount  wallet_bucket='withdrawable' recipient_type='user'
 *   • leg 2: cash_in  amount  wallet_bucket='float'        recipient_type='operational_wallet'
 *
 * Because every wallet bucket is derived from the ledger (wallet_strict →
 * wallet_balances_projection), withdrawable falls and float rises by exactly the
 * same amount — the wallet total never changes and no drift can occur. The
 * frontend never writes wallet or ledger state itself.
 *
 * The withdrawable side is gated on the strict `get_user_available_balance`
 * RPC (never the cached bucket), so pending withdrawal holds cannot be
 * converted out from under Financial Ops.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceKey);

  try {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const { data: { user: authedUser }, error: authError } =
      await adminClient.auth.getUser(token);
    if (authError || !authedUser) return json({ error: "Unauthorized" }, 401);

    // Treasury guard — no money movement while the treasury is paused.
    const guardBlock = await checkTreasuryGuard(adminClient, "any", authedUser.id);
    if (guardBlock) return guardBlock;

    const userId = authedUser.id;

    // Only agents (any agent flavour) hold an operational float bucket.
    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", ["agent", "senior_agent", "sub_agent"]);
    if (!roles?.length) {
      return json({ error: "Only agents can convert balance to float." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const amount =
      typeof body?.amount === "number"
        ? body.amount
        : Number(String(body?.amount ?? "").replace(/[, _]/g, ""));
    const note = String(body?.note ?? "").trim().slice(0, 200);

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "Enter the amount you want to move to float." }, 400);
    }
    if (!Number.isInteger(amount)) {
      return json({ error: "Amount must be a whole number of UGX." }, 400);
    }
    if (amount < 1000) {
      return json({ error: "The smallest amount you can move is UGX 1,000." }, 400);
    }
    if (amount > 100_000_000) {
      return json({ error: "Amount is too large. Contact Financial Ops for amounts above UGX 100,000,000." }, 400);
    }

    // ── Strict availability gate (never the cached bucket) ────────────────
    const { data: availableRaw, error: availErr } = await adminClient
      .rpc("get_user_available_balance", { p_user_id: userId });
    if (availErr) return json({ error: `Balance check failed: ${availErr.message}` }, 500);
    const available = Number(availableRaw ?? 0);

    if (available < amount) {
      return json(
        {
          error: `You only have UGX ${available.toLocaleString()} available to move.`,
          code: "insufficient_withdrawable",
          available,
        },
        422,
      );
    }

    const { data: walletRow } = await adminClient
      .from("wallets")
      .select("float_balance, withdrawable_balance")
      .eq("user_id", userId)
      .maybeSingle();
    const floatBefore = Number(walletRow?.float_balance ?? 0);
    const withdrawableBefore = Number(walletRow?.withdrawable_balance ?? 0);

    const { data: profile } = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("id", userId)
      .maybeSingle();
    const agentName = profile?.full_name || userId;

    const refId = `AGT-WDR2FLT-${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();
    const noteSuffix = note ? ` Note: ${note}` : "";

    const posted = await postBalancedLedgerGroup(adminClient, {
      source: "agent-convert-withdrawable-to-float",
      referenceId: refId,
      entries: [
        {
          user_id: userId,
          amount,
          direction: "cash_out",
          category: "bucket_reclass_out",
          ledger_scope: "wallet",
          recipient_type: "user",
          wallet_bucket: "withdrawable",
          routing_source: "agent_withdrawable_to_float",
          source_table: "agent_withdrawable_to_float",
          reference_id: refId,
          classification: "production",
          currency: "UGX",
          transaction_date: nowIso,
          description: `Converted UGX ${amount.toLocaleString()} from your balance to Float (agent self-service).${noteSuffix}`,
        },
        {
          user_id: userId,
          amount,
          direction: "cash_in",
          category: "bucket_reclass_in",
          ledger_scope: "wallet",
          recipient_type: "operational_wallet",
          wallet_bucket: "float",
          routing_source: "agent_withdrawable_to_float",
          source_table: "agent_withdrawable_to_float",
          reference_id: refId,
          classification: "production",
          currency: "UGX",
          transaction_date: nowIso,
          description: `Float topped up with UGX ${amount.toLocaleString()} from your own balance (agent self-service).${noteSuffix}`,
        },
      ],
      // Cross-bucket move: the engine's single-bucket pre-check cannot judge it;
      // postBalancedLedgerGroup's mapped double-entry assertion guards the write.
      skipBalanceCheck: true,
      // Closes the double-submit race: the availability check above can go
      // stale between two concurrent requests (two devices, a client retry).
      // lockUserId+minAvailable re-check under an advisory lock immediately
      // before posting, so only one of two simultaneous conversions wins.
      lockUserId: userId,
      minAvailable: amount,
    });
    if (!posted.ok) return json({ error: posted.error }, 500);
    const groupId = posted.groupId;

    // Buckets are derived; refresh the projection/cached total immediately so the
    // agent sees the new numbers on the very next read.
    try {
      await adminClient.rpc("refresh_wallet_projection_for", { p_user_id: userId });
    } catch (_) { /* projection catches up on the next ledger write */ }
    try {
      await adminClient.rpc("reconcile_wallet_from_ledger", { p_user_id: userId });
    } catch (_) { /* non-fatal */ }

    await adminClient.from("audit_logs").insert({
      user_id: userId,
      action_type: "agent_withdrawable_to_float",
      table_name: "general_ledger",
      record_id: groupId,
      reason: `Agent self-service conversion of UGX ${amount.toLocaleString()} from withdrawable balance to operational float.${noteSuffix}`,
      metadata: {
        amount,
        note,
        reference_id: refId,
        available_before: available,
        float_before: floatBefore,
        withdrawable_before: withdrawableBefore,
      },
    });

    try {
      await adminClient.from("system_events").insert({
        event_type: "wallet.withdrawable_to_float",
        user_id: userId,
        description: `${agentName} converted UGX ${amount.toLocaleString()} from balance to Float`,
        metadata: { amount, reference_id: refId, actor_id: userId, self_service: true },
      });
    } catch (_) { /* lean-database policy: never fail the move on an event write */ }

    const { data: after } = await adminClient
      .from("wallets")
      .select("float_balance, withdrawable_balance")
      .eq("user_id", userId)
      .maybeSingle();

    const floatAfter = Number(after?.float_balance ?? floatBefore + amount);
    const withdrawableAfter = Number(after?.withdrawable_balance ?? withdrawableBefore - amount);

    return json({
      success: true,
      amount,
      reference_id: refId,
      transaction_group_id: groupId,
      float_before: floatBefore,
      float_after: floatAfter,
      withdrawable_before: withdrawableBefore,
      withdrawable_after: withdrawableAfter,
      message: `UGX ${amount.toLocaleString()} moved to your Float.`,
    });
  } catch (err) {
    console.error("[agent-convert-withdrawable-to-float] error:", (err as Error).message);
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
});
