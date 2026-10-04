import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Role check
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const userRoles = (roles || []).map((r: any) => r.role);
    const allowed = ["coo", "manager", "operations", "super_admin", "cfo"];
    if (!userRoles.some((r: string) => allowed.includes(r))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse body
    const { portfolio_id, reason } = await req.json();
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

    // Fetch portfolio
    const { data: portfolio, error: pErr } = await supabase
      .from("investor_portfolios")
      .select("id, investment_amount, portfolio_code, account_name, investor_id, agent_id")
      .eq("id", portfolio_id)
      .single();
    if (pErr || !portfolio) {
      return new Response(JSON.stringify({ error: "Portfolio not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch approved pending ops
    const { data: pendingOps, error: poErr } = await supabase
      .from("pending_wallet_operations")
      .select("id, amount, transaction_group_id")
      .eq("source_id", portfolio_id)
      .eq("source_table", "investor_portfolios")
      .eq("operation_type", "portfolio_topup")
      .eq("status", "approved");

    if (poErr || !pendingOps || pendingOps.length === 0) {
      return new Response(JSON.stringify({ error: "No approved pending top-ups found for this portfolio" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalPending = pendingOps.reduce((s: number, op: any) => s + Number(op.amount), 0);
    const currentAmount = Number(portfolio.investment_amount);
    const newAmount = currentAmount + totalPending;
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;
    const partnerId = portfolio.investor_id || portfolio.agent_id;
    const pendingIds = pendingOps.map((op: any) => op.id);
    const now = new Date().toISOString();

    // 1. Update portfolio principal
    const { error: updateErr } = await supabase
      .from("investor_portfolios")
      .update({ investment_amount: newAmount })
      .eq("id", portfolio_id);

    if (updateErr) {
      return new Response(JSON.stringify({ error: "Failed to update portfolio: " + updateErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Mark pending ops as completed
    const { error: statusErr } = await supabase
      .from("pending_wallet_operations")
      .update({
        status: "completed",
        reviewed_at: now,
        reviewed_by: user.id,
      })
      .in("id", pendingIds);

    if (statusErr) {
      // Rollback principal
      await supabase
        .from("investor_portfolios")
        .update({ investment_amount: currentAmount })
        .eq("id", portfolio_id);
      return new Response(JSON.stringify({ error: "Failed to update pending ops, rolled back: " + statusErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Balanced ledger entries: pending_portfolio_topup cash_out + partner_funding cash_in
    await supabase.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: partnerId,
          amount: totalPending,
          direction: "cash_out",
          category: "pending_portfolio_topup",
          source_table: "investor_portfolios",
          source_id: portfolio_id,
          description: `Manual merge: ${pendingOps.length} pending top-up(s) into ${accountLabel}. Reason: ${reason.trim()}`,
          currency: "UGX",
          ledger_scope: "platform",
          transaction_date: now,
        },
        {
          user_id: partnerId,
          amount: totalPending,
          direction: "cash_in",
          category: "partner_funding",
          source_table: "investor_portfolios",
          source_id: portfolio_id,
          description: `${pendingOps.length} pending top-up(s) merged into ${accountLabel} — capital activated manually`,
          currency: "UGX",
          ledger_scope: "platform",
          transaction_date: now,
        },
      ],
    });

    // 4. Audit log
    await supabase.from("audit_logs").insert({
      user_id: user.id,
      action_type: "manual_merge_pending_topups",
      table_name: "investor_portfolios",
      record_id: portfolio_id,
      metadata: {
        partner_id: partnerId,
        count: pendingOps.length,
        total_merged: totalPending,
        previous_capital: currentAmount,
        new_capital: newAmount,
        pending_op_ids: pendingIds,
        reason: reason.trim(),
        trigger: "manual",
      },
    });

    // 5. Notify partner
    await supabase.from("notifications").insert({
      user_id: partnerId,
      title: "🔄 Top-Ups Merged Into Capital",
      message: `${pendingOps.length} pending deposit(s) totaling UGX ${totalPending.toLocaleString()} have been added to "${accountLabel}". New capital: UGX ${newAmount.toLocaleString()}.`,
      type: "success",
      metadata: {
        portfolio_id: portfolio_id,
        total_merged: totalPending,
        new_capital: newAmount,
        merged_by: user.id,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        previous_capital: currentAmount,
        merged_amount: totalPending,
        new_capital: newAmount,
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
