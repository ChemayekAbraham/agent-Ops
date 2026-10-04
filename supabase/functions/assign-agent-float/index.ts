import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { guardCfoApprover } from "../_shared/cfoApprovalGate.ts";

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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Authenticate caller
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check caller is staff
    const admin = createClient(supabaseUrl, serviceKey);

    // Only the Chief Finance Officer office or a designated super admin may do this.
    const denied = await guardCfoApprover(admin, user.id, corsHeaders)
    if (denied) return denied
    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const allowedRoles = ["super_admin", "manager", "cfo", "coo", "operations"];
    const hasStaffRole = (roles || []).some((r: any) => allowedRoles.includes(r.role));

    if (!hasStaffRole) {
      return new Response(JSON.stringify({ error: "Forbidden: insufficient role" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse & validate body
    const body = await req.json();
    const { agent_id, amount, description } = body;

    if (!agent_id || typeof agent_id !== "string") {
      return new Response(JSON.stringify({ error: "agent_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!amount || typeof amount !== "number" || amount <= 0) {
      return new Response(JSON.stringify({ error: "amount must be a positive number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify agent exists
    const { data: agentProfile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", agent_id)
      .single();

    if (!agentProfile) {
      return new Response(JSON.stringify({ error: "Agent not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check sender wallet balance
    const { data: senderWallet } = await admin
      .from("wallets")
      .select("balance")
      .eq("user_id", user.id)
      .single();

    if (!senderWallet || senderWallet.balance < amount) {
      return new Response(
        JSON.stringify({ error: `Insufficient balance. Available: ${senderWallet?.balance || 0}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const assignedAt = new Date().toISOString();
    const desc = description || `Operations float from Welile Finance`;

    // Create balanced ledger entries
    const { data: txnGroupId, error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: user.id,
          amount,
          direction: "cash_out",
          category: "agent_float_assignment",
          ledger_scope: "wallet",
          description: `Operations float sent to ${agentProfile.full_name}`,
          currency: "UGX",
          source_table: "agent_float_funding",
          transaction_date: assignedAt,
          linked_party: agent_id,
          metadata: JSON.stringify({ assigned_at: assignedAt, agent_name: agentProfile.full_name }),
        },
        {
          user_id: agent_id,
          amount,
          direction: "cash_in",
          category: "agent_float_assignment",
          ledger_scope: "wallet",
          description: desc,
          currency: "UGX",
          source_table: "agent_float_funding",
          transaction_date: assignedAt,
          linked_party: "platform",
          metadata: JSON.stringify({ assigned_at: assignedAt, assigned_by: user.id, source: "Welile Finance" }),
        },
      ],
    });

    if (ledgerErr) {
      console.error("[assign-agent-float] Ledger error:", ledgerErr);
      return new Response(
        JSON.stringify({ error: "Failed to record ledger entry: " + (ledgerErr.message || "unknown") }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Audit log
    await admin.from("audit_logs").insert({
      user_id: user.id,
      action_type: "agent_float_assigned",
      record_id: agent_id,
      table_name: "general_ledger",
      metadata: {
        amount,
        agent_id,
        agent_name: agentProfile.full_name,
        assigned_at: assignedAt,
        txn_group_id: txnGroupId,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        amount,
        agent: agentProfile.full_name,
        txn_group_id: txnGroupId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[assign-agent-float] Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
