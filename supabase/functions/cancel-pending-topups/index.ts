import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { topupReleaseKey } from "../_shared/topupFloatHold.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await adminClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Allowed roles: COO, Partner Ops (manager/operations), super_admin, CFO
    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const userRoles = (roles || []).map((r: any) => r.role);
    const allowed = ["coo", "manager", "operations", "super_admin", "cfo"];
    if (!userRoles.some((r: string) => allowed.includes(r))) {
      return new Response(JSON.stringify({ error: "Forbidden — COO or Partner Ops only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { portfolio_id, reason, pending_op_ids } = await req.json();
    if (!portfolio_id || typeof portfolio_id !== "string") {
      return new Response(JSON.stringify({ error: "portfolio_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
      return new Response(JSON.stringify({ error: "Reason must be at least 10 characters" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: portfolio, error: pErr } = await adminClient
      .from("investor_portfolios")
      .select("id, portfolio_code, account_name, investor_id, agent_id")
      .eq("id", portfolio_id)
      .single();
    if (pErr || !portfolio) {
      return new Response(JSON.stringify({ error: "Portfolio not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch top-ups whose money is parked: approved ones, plus requests still
    // awaiting approval whose amount was already held from operational float
    // at request time (metadata.float_hold = 'held'). Unheld awaiting requests
    // moved no money and are declined via approve-portfolio-topup instead.
    // Optionally restrict to a specific subset via pending_op_ids.
    let q = adminClient
      .from("pending_wallet_operations")
      .select("id, amount, metadata, status")
      .eq("source_id", portfolio_id)
      .eq("source_table", "investor_portfolios")
      .eq("operation_type", "portfolio_topup")
      .in("status", ["approved", "awaiting_verification"]);
    if (Array.isArray(pending_op_ids) && pending_op_ids.length > 0) {
      q = q.in("id", pending_op_ids);
    }
    const { data: fetchedOps, error: poErr } = await q;
    const pendingOps = (fetchedOps || []).filter((op: any) =>
      op.status === "approved" || (op.metadata && op.metadata.float_hold === "held")
    );

    if (poErr || !pendingOps || pendingOps.length === 0) {
      return new Response(JSON.stringify({ error: "No approved pending top-ups found to cancel" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalCancelled = pendingOps.reduce((s: number, op: any) => s + Number(op.amount), 0);
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;
    const partnerId = portfolio.investor_id || portfolio.agent_id;
    const ids = pendingOps.map((op: any) => op.id);
    const now = new Date().toISOString();

    // 1. Mark pending ops as cancelled
    const { error: cancelErr } = await adminClient
      .from("pending_wallet_operations")
      .update({
        status: "cancelled",
        reviewed_at: now,
        reviewed_by: user.id,
        rejection_reason: `Cancelled by ${userRoles.join("/")}: ${reason.trim()}`,
      })
      .in("id", ids);

    if (cancelErr) {
      return new Response(JSON.stringify({ error: "Failed to cancel: " + cancelErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Balanced refund ledger entries — PER OP so funds return to the EXACT
    //    source wallet and bucket they were originally deducted from.
    //    The original top-up posted:
    //      • wallet-scope cash_out on the source wallet owner (recipient_type
    //        routes the bucket: float→operational_wallet, else→user/withdrawable)
    //      • platform-scope cash_in (pending_portfolio_topup) to park capital
    //    The reversal mirrors these legs in the opposite direction.
    let refundErr: { message: string } | null = null;
    const refundedIds: string[] = [];
    for (const op of pendingOps) {
      const meta = (op.metadata || {}) as Record<string, unknown>;
      // Fall back to the partner wallet + withdrawable bucket for legacy ops
      // that pre-date metadata capture.
      const sourceWalletUserId = (typeof meta.source_wallet_user_id === "string" && meta.source_wallet_user_id)
        ? meta.source_wallet_user_id as string
        : partnerId;
      const fundSource = meta.fund_source === "float" ? "float" : "withdrawable";
      const sourceWalletOwner = (typeof meta.source_wallet_owner === "string" && meta.source_wallet_owner)
        ? meta.source_wallet_owner as string
        : "Partner Wallet";
      const opAmount = Number(op.amount);

      const { error: ledgerErr } = await adminClient.rpc("create_ledger_transaction", {
        // One refund per op, ever — a retried cancel must not refund twice.
        idempotency_key: topupReleaseKey(op.id),
        entries: [
          {
            // Release the parked capital (reverse of the original platform cash_in)
            user_id: partnerId,
            amount: opAmount,
            direction: "cash_out",
            category: "pending_portfolio_topup",
            ledger_scope: "platform",
            source_table: "investor_portfolios",
            source_id: portfolio_id,
            linked_party: sourceWalletUserId,
            description: `Cancelled pending top-up for ${accountLabel} — parked capital released. Reason: ${reason.trim()}`,
            currency: "UGX",
            transaction_date: now,
          },
          {
            // Refund the EXACT source wallet + bucket (reverse of original wallet cash_out)
            user_id: sourceWalletUserId,
            amount: opAmount,
            direction: "cash_in",
            category: "partner_funding",
            ledger_scope: "wallet",
            recipient_type: fundSource === "float" ? "operational_wallet" : "user",
            wallet_bucket: fundSource === "float" ? "float" : "withdrawable",
            source_table: "investor_portfolios",
            source_id: portfolio_id,
            linked_party: "platform",
            description: `Refund of cancelled top-up for ${accountLabel} to ${sourceWalletOwner} (${fundSource === "float" ? "Operational Float" : "Personal Deposit"}). Reason: ${reason.trim()}`,
            currency: "UGX",
            transaction_date: now,
          },
        ],
      });

      if (ledgerErr) {
        refundErr = ledgerErr;
        break;
      }
      refundedIds.push(op.id);
      if (meta.float_hold) {
        await adminClient
          .from("pending_wallet_operations")
          .update({ metadata: { ...meta, float_hold: "released", released_at: now } })
          .eq("id", op.id);
      }

      // Make the refund visible in the source wallet's transaction history.
      await adminClient.from("wallet_transactions").insert({
        sender_id: sourceWalletUserId,
        recipient_id: sourceWalletUserId,
        amount: opAmount,
        description: `Top-up refund: ${accountLabel} cancelled — ${reason.trim()}`,
      });
    }

    if (refundErr) {
      // Roll back only the ops that were NOT refunded, each to the status it
      // had. Refunded ops stay cancelled — putting them back would let an
      // engine apply money that has already been returned.
      for (const op of pendingOps) {
        if (refundedIds.includes(op.id)) continue;
        await adminClient
          .from("pending_wallet_operations")
          .update({ status: op.status, reviewed_at: null, reviewed_by: null, rejection_reason: null })
          .eq("id", op.id);
      }
      return new Response(JSON.stringify({ error: "Ledger refund failed, rolled back: " + refundErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Audit
    await adminClient.from("audit_logs").insert({
      user_id: user.id,
      action_type: "cancel_pending_topups",
      table_name: "investor_portfolios",
      record_id: portfolio_id,
      metadata: {
        partner_id: partnerId,
        count: pendingOps.length,
        total_cancelled: totalCancelled,
        pending_op_ids: ids,
        reason: reason.trim(),
        actor_roles: userRoles,
      },
    });

    // 4. Notify partner
    await adminClient.from("notifications").insert({
      user_id: partnerId,
      title: "↩️ Pending Top-Up Cancelled",
      message: `${pendingOps.length} pending top-up(s) totalling UGX ${totalCancelled.toLocaleString()} on "${accountLabel}" have been cancelled and returned to where they were taken from.`,
      type: "info",
      metadata: {
        portfolio_id,
        total_cancelled: totalCancelled,
        cancelled_by: user.id,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        total_cancelled: totalCancelled,
        ops_count: pendingOps.length,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
