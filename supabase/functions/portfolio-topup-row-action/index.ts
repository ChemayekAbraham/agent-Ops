import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * portfolio-topup-row-action
 *
 * COO / Partner Ops manual override for a single parked/merged top-up row.
 *  - action: "apply"   → force-merge ONE top-up into portfolio principal
 *                        (fallback for when the 7PM merge-paidout-topups cron
 *                         fails to run).
 *  - action: "reverse" → undo a merge that the cron mis-calculated; subtracts
 *                        the amount back out of principal and re-parks the
 *                        top-up (status → approved) so it can re-merge later.
 *
 * NO money leaves the platform in either path — capital just moves between the
 * "parked" (pending_portfolio_topup) and "active" (partner_funding) states.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await adminClient.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const userRoles = (roles || []).map((r: any) => r.role);
    const allowed = ["coo", "manager", "operations", "super_admin", "cfo"];
    if (!userRoles.some((r: string) => allowed.includes(r))) {
      return json({ error: "Forbidden — COO or Partner Ops only" }, 403);
    }

    const { op_id, action, reason } = await req.json();
    if (!op_id || typeof op_id !== "string") {
      return json({ error: "op_id is required" }, 400);
    }
    if (action !== "apply" && action !== "reverse") {
      return json({ error: "action must be 'apply' or 'reverse'" }, 400);
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
      return json({ error: "Reason must be at least 10 characters" }, 400);
    }
    const cleanReason = reason.trim();

    // Fetch the single top-up op
    const { data: op, error: opErr } = await adminClient
      .from("pending_wallet_operations")
      .select("id, amount, status, source_id, source_table, operation_type, metadata")
      .eq("id", op_id)
      .single();
    if (opErr || !op) return json({ error: "Top-up not found" }, 404);
    if (op.operation_type !== "portfolio_topup" || op.source_table !== "investor_portfolios") {
      return json({ error: "Not a portfolio top-up operation" }, 400);
    }

    const { data: portfolio, error: pErr } = await adminClient
      .from("investor_portfolios")
      .select("id, investment_amount, portfolio_code, account_name, investor_id, agent_id, status")
      .eq("id", op.source_id)
      .single();
    if (pErr || !portfolio) return json({ error: "Portfolio not found" }, 404);

    const partnerId = portfolio.investor_id || portfolio.agent_id;
    const label = portfolio.account_name || portfolio.portfolio_code;
    const amount = Number(op.amount) || 0;
    const prev = Number(portfolio.investment_amount) || 0;
    const now = new Date().toISOString();
    const meta = (op.metadata && typeof op.metadata === "object") ? op.metadata : {};

    if (action === "apply") {
      if (!["pending", "awaiting_verification", "approved"].includes(op.status)) {
        return json({ error: `Cannot apply a top-up with status '${op.status}'` }, 400);
      }
      if (portfolio.status !== "active") {
        return json({ error: "Portfolio is not active" }, 400);
      }

      const next = prev + amount;

      const { error: upErr } = await adminClient
        .from("investor_portfolios")
        .update({ investment_amount: next })
        .eq("id", portfolio.id);
      if (upErr) return json({ error: "Failed to update principal: " + upErr.message }, 500);

      const { error: stErr } = await adminClient
        .from("pending_wallet_operations")
        .update({
          status: "completed",
          reviewed_at: now,
          reviewed_by: user.id,
          metadata: { ...meta, merged_at: now, merge_trigger: "manual_apply_cron_fallback", manual_apply_reason: cleanReason },
        })
        .eq("id", op.id);
      if (stErr) {
        await adminClient.from("investor_portfolios").update({ investment_amount: prev }).eq("id", portfolio.id);
        return json({ error: "Failed to update op, rolled back: " + stErr.message }, 500);
      }

      const { error: ledgerErr } = await adminClient.rpc("create_ledger_transaction", {
        entries: [
          {
            user_id: partnerId, amount, direction: "cash_out",
            category: "pending_portfolio_topup", source_table: "investor_portfolios",
            source_id: portfolio.id, currency: "UGX", ledger_scope: "platform",
            description: `Manual apply (cron fallback): top-up into ${label}. Reason: ${cleanReason}`,
            transaction_date: now,
          },
          {
            user_id: partnerId, amount, direction: "cash_in",
            category: "partner_funding", source_table: "investor_portfolios",
            source_id: portfolio.id, currency: "UGX", ledger_scope: "platform",
            description: `Top-up merged into ${label} — capital activated manually. Reason: ${cleanReason}`,
            transaction_date: now,
          },
        ],
      });
      if (ledgerErr) console.error("[portfolio-topup-row-action] apply ledger error:", ledgerErr.message);

      await adminClient.from("audit_logs").insert({
        user_id: user.id, action_type: "manual_apply_topup_row",
        table_name: "investor_portfolios", record_id: portfolio.id,
        metadata: {
          op_id: op.id, partner_id: partnerId, amount,
          previous_capital: prev, new_capital: next,
          reason: cleanReason, actor_roles: userRoles, trigger: "manual_apply",
        },
      });

      if (partnerId) {
        await adminClient.from("notifications").insert({
          user_id: partnerId, title: "🔄 Top-Up Applied To Capital", type: "success",
          message: `A pending deposit of UGX ${amount.toLocaleString()} has been added to "${label}". New capital: UGX ${next.toLocaleString()}.`,
          metadata: { portfolio_id: portfolio.id, amount, new_capital: next, trigger: "manual_apply" },
        });
      }

      return json({ success: true, action, amount, previous_capital: prev, new_capital: next });
    }

    // action === "reverse"
    if (op.status !== "completed") {
      return json({ error: `Only a merged (completed) top-up can be reversed. Current status: '${op.status}'` }, 400);
    }

    const next = Math.max(0, prev - amount);

    const { error: upErr } = await adminClient
      .from("investor_portfolios")
      .update({ investment_amount: next })
      .eq("id", portfolio.id);
    if (upErr) return json({ error: "Failed to update principal: " + upErr.message }, 500);

    const { error: stErr } = await adminClient
      .from("pending_wallet_operations")
      .update({
        status: "approved",
        reviewed_at: now,
        reviewed_by: user.id,
        metadata: { ...meta, reversed_at: now, reversed_by: user.id, reversed_from_merge: true, reverse_reason: cleanReason },
      })
      .eq("id", op.id);
    if (stErr) {
      await adminClient.from("investor_portfolios").update({ investment_amount: prev }).eq("id", portfolio.id);
      return json({ error: "Failed to update op, rolled back: " + stErr.message }, 500);
    }

    const { error: ledgerErr } = await adminClient.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: partnerId, amount, direction: "cash_out",
          category: "partner_funding", source_table: "investor_portfolios",
          source_id: portfolio.id, currency: "UGX", ledger_scope: "platform",
          description: `Reverse merge for ${label} — active capital removed (re-parked). Reason: ${cleanReason}`,
          transaction_date: now,
        },
        {
          user_id: partnerId, amount, direction: "cash_in",
          category: "pending_portfolio_topup", source_table: "investor_portfolios",
          source_id: portfolio.id, currency: "UGX", ledger_scope: "platform",
          description: `Top-up re-parked after reversal on ${label}. Reason: ${cleanReason}`,
          transaction_date: now,
        },
      ],
    });
    if (ledgerErr) console.error("[portfolio-topup-row-action] reverse ledger error:", ledgerErr.message);

    await adminClient.from("audit_logs").insert({
      user_id: user.id, action_type: "reverse_merged_topup_row",
      table_name: "investor_portfolios", record_id: portfolio.id,
      metadata: {
        op_id: op.id, partner_id: partnerId, amount,
        previous_capital: prev, new_capital: next,
        reason: cleanReason, actor_roles: userRoles, trigger: "manual_reverse",
      },
    });

    if (partnerId) {
      await adminClient.from("notifications").insert({
        user_id: partnerId, title: "↩️ Top-Up Merge Reversed", type: "info",
        message: `A merged top-up of UGX ${amount.toLocaleString()} on "${label}" was reversed and re-parked. Capital adjusted to UGX ${next.toLocaleString()}.`,
        metadata: { portfolio_id: portfolio.id, amount, new_capital: next, trigger: "manual_reverse" },
      });
    }

    return json({ success: true, action, amount, previous_capital: prev, new_capital: next });
  } catch (err: any) {
    return json({ error: err?.message || "Internal error" }, 500);
  }
});