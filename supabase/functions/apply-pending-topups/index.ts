import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * apply-pending-topups
 * 
 * COO/Manager action: changes pending top-ups to "awaiting_verification".
 * NO money moves. Financial Ops must approve via approve-portfolio-topup
 * before funds are applied to the portfolio.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify caller is COO/manager
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const allowedRoles = ["coo", "manager", "cfo", "super_admin"];
    const hasRole = (roles || []).some((r: any) => allowedRoles.includes(r.role));
    if (!hasRole) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { portfolio_id } = body;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!portfolio_id || !UUID_RE.test(portfolio_id)) {
      return new Response(JSON.stringify({ error: "Invalid portfolio_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch portfolio
    const { data: portfolio, error: pErr } = await supabase
      .from("investor_portfolios")
      .select("id, investor_id, agent_id, investment_amount, portfolio_code, account_name, status")
      .eq("id", portfolio_id)
      .single();

    if (pErr || !portfolio) {
      return new Response(JSON.stringify({ error: "Portfolio not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all pending top-ups for this portfolio
    const { data: pendingOps, error: fetchErr } = await supabase
      .from("pending_wallet_operations")
      .select("id, amount, user_id, transaction_group_id")
      .eq("source_id", portfolio_id)
      .eq("source_table", "investor_portfolios")
      .eq("operation_type", "portfolio_topup")
      .eq("status", "pending");

    if (fetchErr) {
      return new Response(JSON.stringify({ error: "Failed to fetch pending top-ups" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pendingOps || pendingOps.length === 0) {
      return new Response(JSON.stringify({ error: "No pending top-ups to submit for verification" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalPending = pendingOps.reduce((s, op) => s + Number(op.amount), 0);
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;
    const now = new Date().toISOString();
    const pendingIds = pendingOps.map(op => op.id);

    // Change status from "pending" to "awaiting_verification" — NO money moves
    const { error: updateErr, data: updateData } = await supabase
      .from("pending_wallet_operations")
      .update({
        status: "awaiting_verification",
        reviewed_at: now,
        reviewed_by: user.id,
      })
      .in("id", pendingIds)
      .select();

    console.log("[apply-pending-topups] Update result:", JSON.stringify({ updateErr, updateData, pendingIds }));

    if (updateErr) {
      return new Response(JSON.stringify({ error: "Failed to update status", details: updateErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      user_id: user.id,
      action_type: "submit_topups_for_verification",
      table_name: "pending_wallet_operations",
      record_id: portfolio_id,
      metadata: {
        portfolio_code: portfolio.portfolio_code,
        count: pendingOps.length,
        total_amount: totalPending,
        pending_op_ids: pendingIds,
      },
    });

    // Notify Financial Ops (CFO + financial_ops roles)
    try {
      const { data: finOpsUsers } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["cfo", "operations"]);

      const uniqueIds = [...new Set((finOpsUsers || []).map((e: any) => e.user_id))];
      if (uniqueIds.length > 0) {
        await supabase.from("notifications").insert(
          uniqueIds.map((uid: string) => ({
            user_id: uid,
            title: "🔍 Portfolio Top-Up Awaiting Verification",
            message: `${pendingOps.length} top-up(s) totaling UGX ${totalPending.toLocaleString()} for "${accountLabel}" (${portfolio.portfolio_code}) submitted for verification by operations.`,
            type: "warning",
            metadata: { portfolio_id, total_amount: totalPending, portfolio_code: portfolio.portfolio_code, submitted_by: user.id },
          }))
        );
      }
    } catch (notifErr) {
      console.error("[apply-pending-topups] Notification error (non-blocking):", notifErr);
    }

    console.log(`[apply-pending-topups] ${user.id} submitted ${pendingOps.length} top-ups (${totalPending}) for verification on ${portfolio_id}`);

    return new Response(JSON.stringify({
      success: true,
      count: pendingOps.length,
      total_amount: totalPending,
      status: "awaiting_verification",
      portfolio_code: portfolio.portfolio_code,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[apply-pending-topups] Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
