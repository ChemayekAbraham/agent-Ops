import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

    const body = await req.json();
    const withdrawalId = String(body?.withdrawal_id || "").trim();
    const reason = String(body?.reason || "").trim();

    if (!withdrawalId) {
      return new Response(JSON.stringify({ error: "withdrawal_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (reason.length < 10) {
      return new Response(JSON.stringify({ error: "reason must be at least 10 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch withdrawal & validate caller is the linked proxy agent
    const { data: w, error: wErr } = await admin
      .from("withdrawal_requests")
      .select("id, user_id, amount, status, requested_by")
      .eq("id", withdrawalId)
      .single();
    if (wErr || !w) {
      return new Response(JSON.stringify({ error: "Withdrawal not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!["pending", "requested", "manager_approved", "cfo_approved", "processing"].includes(String(w.status))) {
      return new Response(JSON.stringify({ error: `Cannot cancel — current status: ${w.status}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Caller must be the proxy agent assigned to this partner
    const { data: proxyLink } = await admin
      .from("proxy_agent_assignments")
      .select("agent_id")
      .eq("agent_id", user.id)
      .eq("partner_id", w.user_id)
      .eq("is_active", true)
      .maybeSingle();
    if (!proxyLink) {
      // Fallback: allow super_admin / coo / manager
      const { data: roles } = await admin
        .from("user_roles").select("role").eq("user_id", user.id);
      const ok = (roles || []).some((r: any) => ["super_admin","coo","manager"].includes(r.role));
      if (!ok) {
        return new Response(JSON.stringify({ error: "Forbidden — not the proxy agent for this partner" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const amount = Number(w.amount || 0);
    if (!amount) {
      return new Response(JSON.stringify({ error: "Withdrawal amount unavailable" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1) Mark withdrawal cancelled
    const { error: updErr } = await admin
      .from("withdrawal_requests")
      .update({ status: "cancelled", reason: `[CANCELLED] ${reason}` } as any)
      .eq("id", withdrawalId);
    if (updErr) throw updErr;

    // 2) Balanced reversal pair: platform cash_out → partner wallet cash_in.
    //    Uses 'orphan_reversal' (in strict-mode allowlist) to restore the
    //    partner's ROI returns that were earmarked for the withdrawal.
    const nowIso = new Date().toISOString();
    const { data: txnGroupId, error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
      entries: [
        {
          amount,
          direction: "cash_out",
          category: "orphan_reversal",
          ledger_scope: "platform",
          description: `Reverse cancelled proxy withdrawal ${withdrawalId}`,
          currency: "UGX",
          source_table: "withdrawal_requests",
          source_id: withdrawalId,
          transaction_date: nowIso,
        },
        {
          user_id: w.user_id,
          amount,
          direction: "cash_in",
          category: "orphan_reversal",
          ledger_scope: "wallet",
          description: `ROI returns restored — proxy withdrawal cancelled by agent. Reason: ${reason}`,
          currency: "UGX",
          source_table: "withdrawal_requests",
          source_id: withdrawalId,
          linked_party: user.id,
          transaction_date: nowIso,
        },
      ],
    });
    if (ledgerErr) {
      console.error("[cancel-proxy-withdrawal] Ledger error:", ledgerErr);
      return new Response(JSON.stringify({ error: ledgerErr.message || "Ledger reversal failed" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3) Audit log
    await admin.from("audit_logs").insert({
      user_id: user.id,
      action_type: "proxy_withdrawal_cancelled",
      table_name: "withdrawal_requests",
      record_id: withdrawalId,
      metadata: { partner_id: w.user_id, amount, reason, txn_group_id: txnGroupId },
    });

    // 4) Notify COO + Operations (best-effort)
    try {
      const [{ data: cooUsers }, { data: opsUsers }, { data: agentProfile }, { data: partnerProfile }] = await Promise.all([
        admin.from("user_roles").select("user_id").eq("role", "coo"),
        admin.from("user_roles").select("user_id").eq("role", "operations"),
        admin.from("profiles").select("full_name").eq("id", user.id).single(),
        admin.from("profiles").select("full_name").eq("id", w.user_id).single(),
      ]);
      const ids = new Set<string>();
      (cooUsers || []).forEach((u: any) => ids.add(u.user_id));
      (opsUsers || []).forEach((u: any) => ids.add(u.user_id));
      ids.delete(user.id);
      const agentName = agentProfile?.full_name || "Agent";
      const partnerName = partnerProfile?.full_name || "Partner";
      if (ids.size > 0) {
        await admin.from("notifications").insert(
          [...ids].map((uid) => ({
            user_id: uid,
            title: "Proxy Withdrawal Cancelled",
            message: `${agentName} cancelled a proxy withdrawal of UGX ${amount.toLocaleString()} for ${partnerName}. Reason: ${reason}`,
            type: "warning",
            metadata: {
              action: "proxy_withdrawal_cancelled",
              withdrawal_id: withdrawalId, agent_id: user.id, agent_name: agentName,
              partner_name: partnerName, amount, reason,
            },
          }))
        );
      }
    } catch (e) { console.warn("[cancel-proxy-withdrawal] notify failed:", e); }

    return new Response(JSON.stringify({
      success: true, amount, txn_group_id: txnGroupId,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[cancel-proxy-withdrawal] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});