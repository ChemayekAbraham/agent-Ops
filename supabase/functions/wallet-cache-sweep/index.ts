// CFO Cache Sweep — the ONLY path that may reduce a cached wallets.* bucket
// without a corresponding real-money movement.
//
// Purpose: when the cached `wallets.withdrawable_balance` / `wallets.float_balance`
// sits ABOVE the strict ledger-derived position (a "phantom" amount, usually
// from anchored backfills, retired ROI cycles, or pre-strict-mode legacy posts),
// CFO can sweep up to that phantom delta. The amount is hard-capped at
// `cached − strict` so this tool can NEVER touch real customer-owed money.
//
// Posts a balanced ledger pair under classification='admin_correction',
// category='system_balance_correction'. End-user wallet views already filter
// admin corrections out, so the user's strict figure does not change. The
// cache mirror updates atomically via apply_wallet_movement.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Bucket = "withdrawable" | "float";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userRes?.user) return json({ error: "Unauthorized" }, 401);
    const caller = userRes.user;

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Cache Sweep is CFO-only (super_admin / manager bypass for emergencies).
    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id);
    const allowed = ["super_admin", "manager", "cfo"];
    if (!(roles || []).some((r: any) => allowed.includes(r.role))) {
      return json({ error: "Forbidden: CFO role required for cache sweep" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { target_user_id, bucket, amount, reason } = body as {
      target_user_id?: string;
      bucket?: Bucket;
      amount?: number;
      reason?: string;
    };

    if (!target_user_id || typeof target_user_id !== "string") {
      return json({ error: "target_user_id is required" }, 400);
    }
    if (bucket !== "withdrawable" && bucket !== "float") {
      return json({ error: "bucket must be 'withdrawable' or 'float'" }, 400);
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return json({ error: "amount must be a positive number" }, 400);
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
      return json({ error: "reason must be at least 10 characters" }, 400);
    }

    // Pull cached + strict figures.
    const { data: walletRow, error: wErr } = await adminClient
      .from("wallets")
      .select("withdrawable_balance, float_balance, balance")
      .eq("user_id", target_user_id)
      .maybeSingle();
    if (wErr || !walletRow) return json({ error: "Wallet not found" }, 404);

    const { data: strictView, error: vErr } = await adminClient.rpc(
      "get_user_wallet_view",
      { p_user_id: target_user_id },
    );
    if (vErr) return json({ error: `Strict view failed: ${vErr.message}` }, 500);
    const sv = (strictView ?? {}) as Record<string, unknown>;
    const strictWithdrawable = Number((sv.withdrawable as number | string) ?? 0);
    const strictFloat = Number((sv.float_balance as number | string) ?? 0);

    const cachedWithdrawable = Number(walletRow.withdrawable_balance ?? 0);
    const cachedFloat = Number(walletRow.float_balance ?? 0);

    const phantom =
      bucket === "withdrawable"
        ? Math.max(0, cachedWithdrawable - strictWithdrawable)
        : Math.max(0, cachedFloat - strictFloat);

    if (phantom <= 0) {
      return json(
        {
          error: `No phantom amount on ${bucket} bucket. Cached: UGX ${(bucket === "withdrawable" ? cachedWithdrawable : cachedFloat).toLocaleString()}, Strict: UGX ${(bucket === "withdrawable" ? strictWithdrawable : strictFloat).toLocaleString()}.`,
        },
        422,
      );
    }
    if (amount > phantom) {
      // Log the over-request for audit, then reject.
      await adminClient.from("wallet_overdraw_events").insert({
        user_id: target_user_id,
        attempted_by: caller.id,
        attempted_amount: amount,
        available_amount: phantom,
        bucket,
        reason: "cache_sweep_overrequest",
      }).then(() => {}, () => {});
      return json(
        {
          error: `Requested UGX ${amount.toLocaleString()} exceeds phantom delta of UGX ${phantom.toLocaleString()} on ${bucket}. Cache Sweep can never touch real customer funds.`,
        },
        422,
      );
    }

    // Build a balanced ledger pair under admin_correction so the user's
    // strict view (which filters this category) is unaffected, while the
    // cache mirror gets adjusted down via apply_wallet_movement.
    const nowIso = new Date().toISOString();
    const recipientType = bucket === "withdrawable" ? "user" : "operational_wallet";
    const entries = [
      {
        user_id: target_user_id,
        amount,
        direction: "cash_out",
        category: "system_balance_correction",
        ledger_scope: "wallet",
        description: `CFO Cache Sweep (${bucket}): ${reason.trim()}`,
        currency: "UGX",
        source_table: "wallet_cache_sweep",
        linked_party: caller.id,
        transaction_date: nowIso,
        recipient_type: recipientType,
        classification: "admin_correction",
        // Required by enforce_no_negative_wallet_ledger for admin_correction
        // cash_out wallet legs. A cache sweep is an operator-seeded correction.
        solvency_bypass_reason: "admin_correction_seed",
      },
      {
        direction: "cash_in",
        amount,
        category: "system_balance_correction",
        ledger_scope: "platform",
        description: `Platform absorbs phantom (${bucket}): ${reason.trim()}`,
        currency: "UGX",
        source_table: "wallet_cache_sweep",
        transaction_date: nowIso,
        classification: "admin_correction",
      },
    ];

    const { data: txnGroupId, error: ledgerErr } = await adminClient.rpc(
      "create_ledger_transaction",
      { entries },
    );
    if (ledgerErr) {
      console.error("[cache-sweep] ledger error", ledgerErr);
      return json({ error: ledgerErr.message || "Ledger post failed" }, 400);
    }

    // Audit log (mandatory schema: action_type, table_name, record_id, reason).
    await adminClient.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "cache_sweep",
      table_name: "wallets",
      record_id: target_user_id,
      reason: reason.trim(),
      metadata: {
        bucket,
        amount,
        phantom_before: phantom,
        cached_withdrawable_before: cachedWithdrawable,
        cached_float_before: cachedFloat,
        strict_withdrawable: strictWithdrawable,
        strict_float: strictFloat,
        txn_group_id: txnGroupId,
      },
    }).then(() => {}, () => {});

    // Emit system_event (constitution: every state change must emit one).
    await adminClient.from("system_events").insert({
      event_name: "wallet.cache_sweep.applied",
      actor_user_id: caller.id,
      target_user_id,
      payload: {
        bucket,
        amount,
        phantom_before: phantom,
        txn_group_id: txnGroupId,
      },
    }).then(() => {}, () => {});

    return json({
      success: true,
      bucket,
      amount_swept: amount,
      phantom_before: phantom,
      phantom_after: phantom - amount,
      txn_group_id: txnGroupId,
    });
  } catch (e: any) {
    console.error("[cache-sweep] fatal", e);
    return json({ error: e?.message || "Unexpected error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}