// Sends an agent a friendly email receipt every time they pay rent for a
// tenant via `agent_allocate_tenant_payment`. The email shows:
//   - what they just paid (and commission they earned)
//   - this tenant's remaining balance + daily target
//   - their day-so-far collection report
//   - their current wallet capacity (float / withdrawable / advance)
//
// Fire-and-forget. Failure here MUST NEVER block the allocation flow.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveOwnedRecipientEmail } from "../_shared/ownedRecipientEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Body {
  agent_id: string;
  tenant_id: string;
  rent_request_id?: string | null;
  amount: number;
  commission?: number;
  allocation_id?: string | null;
}

function eatTodayBounds(): { startISO: string; endISO: string; label: string } {
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = eatNow.getUTCFullYear();
  const m = eatNow.getUTCMonth();
  const d = eatNow.getUTCDate();
  const startEAT = Date.UTC(y, m, d, 0, 0, 0) - 3 * 60 * 60 * 1000;
  const endEAT = startEAT + 24 * 60 * 60 * 1000;
  return {
    startISO: new Date(startEAT).toISOString(),
    endISO: new Date(endEAT).toISOString(),
    label: new Date(startEAT).toISOString().slice(0, 10),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = (await req.json()) as Body;
    if (!body?.agent_id || !body?.tenant_id || !Number.isFinite(body?.amount)) {
      return new Response(JSON.stringify({ success: false, error: "missing_fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const [agentRes, tenantRes, walletRes, rentReqRes] = await Promise.all([
      admin.from("profiles").select("id, full_name, email").eq("id", body.agent_id).maybeSingle(),
      admin.from("profiles").select("id, full_name").eq("id", body.tenant_id).maybeSingle(),
      admin
        .from("wallets")
        .select("float_balance, withdrawable_balance, advance_balance")
        .eq("user_id", body.agent_id)
        .maybeSingle(),
      body.rent_request_id
        ? admin
            .from("rent_requests")
            .select("total_repayment, amount_repaid, daily_repayment")
            .eq("id", body.rent_request_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const agent = agentRes.data as { id: string; full_name?: string | null; email?: string | null } | null;
    if (!agent?.email) {
      console.warn("[send-agent-payment-receipt-email] agent has no email — skipping", body.agent_id);
      return new Response(JSON.stringify({ success: false, error: "agent_no_email" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tenant = tenantRes.data as { full_name?: string | null } | null;
    const wallet = walletRes.data as
      | { float_balance?: number | null; withdrawable_balance?: number | null; advance_balance?: number | null }
      | null;
    const rentReq = rentReqRes.data as
      | { total_repayment?: number | null; amount_repaid?: number | null; daily_repayment?: number | null }
      | null;

    // Build the agent's tenant allowlist (same as agent-daily-collection-report)
    const [profilesRel, referralsRel, requestsRel] = await Promise.all([
      admin.from("profiles").select("id").eq("referrer_id", body.agent_id),
      admin.from("referrals").select("referred_id").eq("referrer_id", body.agent_id),
      admin.from("rent_requests").select("tenant_id").eq("agent_id", body.agent_id),
    ]);
    const tenantIds = new Set<string>();
    (profilesRel.data || []).forEach((p: any) => p?.id && tenantIds.add(p.id));
    (referralsRel.data || []).forEach((r: any) => r?.referred_id && tenantIds.add(r.referred_id));
    (requestsRel.data || []).forEach((r: any) => r?.tenant_id && tenantIds.add(r.tenant_id));

    const { startISO, endISO } = eatTodayBounds();
    let collected_today = 0;
    const paidTenants = new Set<string>();
    let expected_today = 0;
    const owingTenants = new Set<string>();

    if (tenantIds.size > 0) {
      const ids = Array.from(tenantIds);
      const [todaysRep, activeReqs] = await Promise.all([
        admin
          .from("repayments")
          .select("tenant_id, amount, created_at")
          .in("tenant_id", ids)
          .gte("created_at", startISO)
          .lt("created_at", endISO),
        admin
          .from("rent_requests")
          .select("tenant_id, total_repayment, amount_repaid, daily_repayment, status")
          .in("tenant_id", ids)
          .in("status", ["approved", "funded", "disbursed", "repaying"]),
      ]);
      (todaysRep.data || []).forEach((r: any) => {
        collected_today += Number(r.amount || 0);
        if (r.tenant_id) paidTenants.add(r.tenant_id);
      });
      (activeReqs.data || []).forEach((rr: any) => {
        const owing = Number(rr.total_repayment || 0) - Number(rr.amount_repaid || 0);
        if (owing > 0) {
          owingTenants.add(rr.tenant_id);
          expected_today += Number(rr.daily_repayment || 0);
        }
      });
    }

    const rate_today = expected_today > 0 ? Math.round((collected_today / expected_today) * 100) : 0;
    const remaining_for_tenant = rentReq
      ? Math.max(0, Number(rentReq.total_repayment || 0) - Number(rentReq.amount_repaid || 0))
      : 0;
    const daily_for_tenant = Number(rentReq?.daily_repayment || 0);

    // Ownership guard: only email the receipt to an address that provably
    // belongs to this agent (see _shared/ownedRecipientEmail.ts). Shared
    // gmail addresses across accounts caused receipt cross-delivery.
    const ownedAgentEmail = await resolveOwnedRecipientEmail(
      admin,
      body.agent_id,
      "send-agent-payment-receipt-email",
    );
    if (!ownedAgentEmail) {
      return new Response(
        JSON.stringify({ success: false, reason: "no_owned_recipient_email" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const idempotencyKey = `agent-pay-receipt-${body.allocation_id || `${body.agent_id}-${body.tenant_id}-${Date.now()}`}`;

    const { error: invokeErr } = await admin.functions.invoke("send-transactional-email", {
      body: {
        templateName: "agent-tenant-payment-receipt",
        recipientEmail: ownedAgentEmail,
        idempotencyKey,
        templateData: {
          agent_name: agent.full_name?.split(" ")[0] || "there",
          tenant_name: tenant?.full_name || "your tenant",
          amount: body.amount,
          commission: Number(body.commission || 0),
          float_left: Number(wallet?.float_balance || 0),
          withdrawable: Number(wallet?.withdrawable_balance || 0),
          advance_owed: Number(wallet?.advance_balance || 0),
          collected_today,
          expected_today,
          rate_today,
          tenants_paid: paidTenants.size,
          tenants_still_owing: owingTenants.size,
          remaining_for_tenant,
          daily_for_tenant,
        },
      },
    });

    if (invokeErr) {
      console.error("[send-agent-payment-receipt-email] invoke failed", invokeErr);
      return new Response(JSON.stringify({ success: false, error: invokeErr.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[send-agent-payment-receipt-email] error", err);
    return new Response(
      JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});