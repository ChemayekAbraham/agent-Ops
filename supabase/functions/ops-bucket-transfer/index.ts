import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * ops-bucket-transfer
 * ─────────────────────────────────────────────────────────────────────
 * Operator-only correction tool: moves funds between a single user's
 * wallet buckets (Withdrawable ↔ Float) when an inbound deposit was
 * accidentally routed to the wrong bucket (e.g. personal deposit that
 * should have been operational float, or vice-versa).
 *
 * Auth: caller MUST hold one of cfo | manager | super_admin | operations.
 *
 * Body: {
 *   target_user_id: string,
 *   amount: number (> 0),
 *   direction: 'withdrawable_to_float' | 'float_to_withdrawable',
 *   reason: string (≥ 10 chars, audit requirement)
 * }
 *
 * Posts ONE balanced wallet-scope ledger pair on the target user. Bucket
 * routing is driven by the chosen categories (see wallet_route_for_category):
 *   withdrawable_to_float:
 *     cash_out  wallet_deduction     → withdrawable
 *     cash_in   agent_float_deposit  → float
 *   float_to_withdrawable:
 *     cash_out  agent_float_deposit  → float
 *     cash_in   wallet_transfer      → withdrawable
 *
 * Wallet buckets are updated by the ledger trigger only — never by this
 * function directly. UI refreshes via the realtime `wallets` channel.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization header" }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const allowed = new Set(["cfo", "manager", "super_admin", "operations"]);
    const callerRoles = (roleRows ?? []).map((r: any) => r.role);
    if (!callerRoles.some((r: string) => allowed.has(r))) {
      return json({ error: "FORBIDDEN", message: "CFO / Manager / Operations role required." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const target_user_id = String((body as any)?.target_user_id ?? "").trim();
    const rawAmount = (body as any)?.amount;
    const amount = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
    const direction = String((body as any)?.direction ?? "");
    const reason = String((body as any)?.reason ?? "").trim();

    if (!target_user_id) return json({ error: "target_user_id required" }, 400);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 500_000_000) {
      return json({ error: "Invalid amount (1 - 500,000,000)" }, 400);
    }
    if (direction !== "withdrawable_to_float" && direction !== "float_to_withdrawable") {
      return json({ error: "direction must be 'withdrawable_to_float' or 'float_to_withdrawable'" }, 400);
    }
    if (reason.length < 10) {
      return json({ error: "Reason must be at least 10 characters (audit requirement)" }, 400);
    }

    const { data: targetProfile } = await admin
      .from("profiles").select("id, full_name, email").eq("id", target_user_id).maybeSingle();
    if (!targetProfile) return json({ error: "Target user not found" }, 404);

    const { data: wallet, error: walletErr } = await admin
      .from("wallets")
      .select("withdrawable_balance, float_balance")
      .eq("user_id", target_user_id)
      .maybeSingle();
    if (walletErr) return json({ error: "Wallet lookup failed", message: walletErr.message }, 500);

    const withdrawableBefore = Number(wallet?.withdrawable_balance ?? 0);
    const floatBefore = Number(wallet?.float_balance ?? 0);

    const isW2F = direction === "withdrawable_to_float";
    const sourceBucket = isW2F ? "withdrawable" : "float";
    const sourceBalance = isW2F ? withdrawableBefore : floatBefore;

    if (sourceBalance < amount) {
      return json({
        error: "INSUFFICIENT_FUNDS",
        message: `${sourceBucket === "float" ? "Operational Float" : "Withdrawable"} balance (UGX ${sourceBalance.toLocaleString()}) is less than requested transfer (UGX ${amount.toLocaleString()}).`,
        available: sourceBalance,
        requested: amount,
      }, 400);
    }

    const ref = `bucket-fix-${target_user_id}-${Date.now()}`;
    const nowIso = new Date().toISOString();

    const entries = isW2F
      ? [
          {
            user_id: target_user_id, amount, direction: "cash_out",
            category: "wallet_deduction", ledger_scope: "wallet",
            wallet_bucket: "withdrawable", recipient_type: "user",
            description: `Ops correction: move from Withdrawable to Float (${reason})`,
            currency: "UGX", reference_id: ref, transaction_date: nowIso,
          },
          {
            user_id: target_user_id, amount, direction: "cash_in",
            category: "agent_float_deposit", ledger_scope: "wallet",
            wallet_bucket: "float", recipient_type: "operational_wallet",
            description: `Ops correction: credit Operational Float (${reason})`,
            currency: "UGX", reference_id: ref, transaction_date: nowIso,
          },
        ]
      : [
          {
            user_id: target_user_id, amount, direction: "cash_out",
            category: "agent_float_deposit", ledger_scope: "wallet",
            wallet_bucket: "float", recipient_type: "operational_wallet",
            description: `Ops correction: debit Operational Float (${reason})`,
            currency: "UGX", reference_id: ref, transaction_date: nowIso,
          },
          {
            user_id: target_user_id, amount, direction: "cash_in",
            category: "wallet_transfer", ledger_scope: "wallet",
            wallet_bucket: "withdrawable", recipient_type: "user",
            description: `Ops correction: credit Withdrawable from Float (${reason})`,
            currency: "UGX", reference_id: ref, transaction_date: nowIso,
          },
        ];

    const { data: txGroupId, error: ledgerErr } = await admin.rpc(
      "create_ledger_transaction",
      { entries, idempotency_key: ref },
    );

    if (ledgerErr) {
      console.error("[ops-bucket-transfer] ledger error:", ledgerErr);
      return json({ error: "LEDGER_FAILED", message: ledgerErr.message ?? "Ledger failed" }, 400);
    }

    await admin.from("audit_logs").insert({
      user_id: user.id,
      action_type: "ops_bucket_transfer",
      table_name: "wallets",
      record_id: target_user_id,
      metadata: {
        target_user_id,
        target_name: targetProfile.full_name,
        amount,
        direction,
        reason,
        withdrawable_before: withdrawableBefore,
        float_before: floatBefore,
        transaction_group_id: txGroupId,
      },
    });

    return json({
      ok: true,
      transaction_group_id: txGroupId,
      target: { id: target_user_id, name: targetProfile.full_name },
      amount,
      direction,
    }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[ops-bucket-transfer] error:", message);
    return json({ error: "INTERNAL_ERROR", message }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}