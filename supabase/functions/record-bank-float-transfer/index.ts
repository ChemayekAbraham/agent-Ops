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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Only the Chief Finance Officer office or a designated super admin may do this.
    const denied = await guardCfoApprover(admin, user.id, corsHeaders)
    if (denied) return denied

    // Caller must be CFO / manager / super_admin
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", user.id);
    const allowed = ["cfo", "manager", "super_admin"];
    if (!(roles || []).some((r: any) => allowed.includes(r.role))) {
      return new Response(JSON.stringify({ error: "Forbidden — CFO role required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const agentId = String(body?.agent_id || "").trim();
    const amount = Number(body?.amount);
    const bankRef = String(body?.bank_reference || "").trim();
    const bankName = String(body?.bank_name || "Equity Bank Uganda").trim();
    const notes = body?.notes ? String(body.notes) : null;

    if (!agentId) {
      return new Response(JSON.stringify({ error: "agent_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return new Response(JSON.stringify({ error: "amount must be a positive number" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!bankRef) {
      return new Response(JSON.stringify({ error: "bank_reference (TID) is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1) Insert funding record
    const { data: fundingRow, error: fundingErr } = await admin.from("agent_float_funding").insert({
      agent_id: agentId,
      amount,
      funded_by: user.id,
      notes,
      bank_reference: bankRef,
      bank_name: bankName,
    } as any).select("id").single();
    if (fundingErr) throw fundingErr;

    const { data: agentProfile } = await admin
      .from("profiles").select("full_name").eq("id", agentId).single();
    const agentName = agentProfile?.full_name || "Agent";

    // 2) Balanced ledger pair using strict-mode allowlisted category
    const nowIso = new Date().toISOString();
    const { data: txnGroupId, error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: user.id,
          amount,
          direction: "cash_out",
          category: "agent_float_assignment",
          ledger_scope: "platform",
          description: `Bank float sent to ${agentName} via ${bankName}. TID: ${bankRef}`,
          currency: "UGX",
          source_table: "agent_float_funding",
          source_id: fundingRow?.id,
          linked_party: agentId,
          transaction_date: nowIso,
        },
        {
          user_id: agentId,
          amount,
          direction: "cash_in",
          category: "agent_float_assignment",
          ledger_scope: "wallet",
          description: `Float funded via ${bankName}. TID: ${bankRef}`,
          currency: "UGX",
          source_table: "agent_float_funding",
          source_id: fundingRow?.id,
          linked_party: user.id,
          transaction_date: nowIso,
        },
      ],
    });
    if (ledgerErr) {
      console.error("[record-bank-float-transfer] Ledger error:", ledgerErr);
      return new Response(JSON.stringify({ error: ledgerErr.message || "Ledger write failed" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.from("audit_logs").insert({
      user_id: user.id,
      action_type: "agent_float_funded",
      table_name: "agent_float_funding",
      record_id: fundingRow?.id,
      metadata: { agent_id: agentId, amount, bank_reference: bankRef, bank_name: bankName, txn_group_id: txnGroupId },
    });

    return new Response(JSON.stringify({
      success: true, funding_id: fundingRow?.id, txn_group_id: txnGroupId,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[record-bank-float-transfer] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});