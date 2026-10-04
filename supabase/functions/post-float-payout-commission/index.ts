import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Posts the 1% agent commission for a verified landlord float payout.
// Server-only — replaces a previous frontend-side balanced ledger insert.
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

    // Caller must be financial-ops / manager / cfo / super_admin
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", user.id);
    const allowed = ["super_admin", "manager", "cfo", "operations", "financial_ops"];
    if (!(roles || []).some((r: any) => allowed.includes(r.role))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const withdrawalId = String(body?.withdrawal_id || "").trim();
    const tid = String(body?.transaction_id || "").trim();
    if (!withdrawalId) {
      return new Response(JSON.stringify({ error: "withdrawal_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotency: skip if commission already posted for this withdrawal
    const { data: existing } = await admin
      .from("general_ledger")
      .select("id")
      .eq("source_table", "agent_float_withdrawals")
      .eq("source_id", withdrawalId)
      .eq("category", "agent_commission_earned")
      .limit(1)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ success: true, idempotent: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: payout, error: pErr } = await admin
      .from("agent_float_withdrawals")
      .select("id, agent_id, amount, landlord_name")
      .eq("id", withdrawalId)
      .single();
    if (pErr || !payout) {
      return new Response(JSON.stringify({ error: "Payout not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const commission = Number(payout.amount) * 0.01;
    if (commission <= 0) {
      return new Response(JSON.stringify({ success: true, commission: 0 }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const nowIso = new Date().toISOString();
    const { data: txnGroupId, error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: payout.agent_id,
          amount: commission,
          direction: "cash_in",
          category: "agent_commission_earned",
          ledger_scope: "wallet",
          description: `1% commission on float payout to ${payout.landlord_name}${tid ? ` (TID: ${tid})` : ""}`,
          currency: "UGX",
          source_table: "agent_float_withdrawals",
          source_id: withdrawalId,
          transaction_date: nowIso,
          role_type: "agent",
        },
        {
          amount: commission,
          direction: "cash_out",
          category: "marketing_expense",
          ledger_scope: "platform",
          description: `Platform commission (1%) for float payout${tid ? ` TID: ${tid}` : ""}`,
          currency: "UGX",
          source_table: "agent_float_withdrawals",
          source_id: withdrawalId,
          transaction_date: nowIso,
        },
      ],
    });
    if (ledgerErr) {
      console.error("[post-float-payout-commission] Ledger error:", ledgerErr);
      return new Response(JSON.stringify({ error: ledgerErr.message || "Ledger write failed" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      success: true, commission, txn_group_id: txnGroupId,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[post-float-payout-commission] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});