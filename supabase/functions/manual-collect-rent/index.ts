import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "manual-collect-rent" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return false;
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({ username, from: "WELILE", to: formatPhoneInternational(phone), message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const data = await res.json();
    return (data?.SMSMessageData?.Recipients || []).some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch { return false; }
}

const corsContentType = { ...corsHeaders, "Content-Type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsContentType });

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsContentType });

    const allowedRoles = ["manager", "super_admin", "operations", "coo", "cfo", "ceo", "employee"];
    const { data: userRoles } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
    if (!userRoles?.some((r: any) => allowedRoles.includes(r.role))) {
      return new Response(JSON.stringify({ error: "Only authorized staff can collect rent manually" }), { status: 403, headers: corsContentType });
    }

    const body = await req.json();
    const { rent_request_id, reason, amount } = body;

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!rent_request_id || !UUID_REGEX.test(rent_request_id)) {
      return new Response(JSON.stringify({ error: "Invalid rent_request_id" }), { status: 400, headers: corsContentType });
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
      return new Response(JSON.stringify({ error: "A reason of at least 10 characters is required" }), { status: 400, headers: corsContentType });
    }
    const trimmedReason = reason.trim();

    const { data: rr, error: rrErr } = await supabase.from("rent_requests").select("*").eq("id", rent_request_id).single();
    if (rrErr || !rr) return new Response(JSON.stringify({ error: "Rent request not found" }), { status: 404, headers: corsContentType });

    const outstanding = Number(rr.total_repayment) - Number(rr.amount_repaid);
    if (outstanding <= 0) return new Response(JSON.stringify({ error: "No outstanding balance to collect" }), { status: 400, headers: corsContentType });

    // Determine how much to attempt to collect:
    // - When an explicit `amount` is supplied, this is a PARTIAL (or custom) collection.
    //   It must be a positive number and is capped at the outstanding balance.
    // - Otherwise default to the daily charge capped at outstanding (legacy behaviour).
    const defaultCharge = Math.min(outstanding, Number(rr.daily_repayment) || outstanding);
    let requestedAmount = defaultCharge;
    let isPartial = false;
    if (amount !== undefined && amount !== null && amount !== "") {
      const parsed = Number(amount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return new Response(JSON.stringify({ error: "Collection amount must be a positive number" }), { status: 400, headers: corsContentType });
      }
      requestedAmount = Math.min(Math.round(parsed), outstanding);
      isPartial = requestedAmount < outstanding;
    }

    const { data: tenantProfile } = await supabase.from("profiles").select("full_name, phone").eq("id", rr.tenant_id).single();
    const tenantName = tenantProfile?.full_name || "Unknown Tenant";
    const tenantPhone = tenantProfile?.phone || "";

    const { data: agentProfile } = await supabase.from("profiles").select("full_name").eq("id", user.id).single();
    const agentName = agentProfile?.full_name || "Your Agent";

    const { data: tenantWallet } = await supabase.from("wallets").select("balance").eq("user_id", rr.tenant_id).single();
    const tenantBalance = Number(tenantWallet?.balance || 0);
    const chargeAmount = requestedAmount;

    let tenantDeducted = 0;
    let agentDeducted = 0;
    let shortfall = chargeAmount;

    // Deduct from tenant wallet via balanced RPC
    if (tenantBalance > 0) {
      tenantDeducted = Math.min(tenantBalance, shortfall);

      const tenantTxDate = new Date().toISOString();
      const { error: tenantRpcErr } = await supabase.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: rr.tenant_id, ledger_scope: 'wallet', direction: 'cash_out',
            amount: tenantDeducted, category: 'tenant_repayment',
            source_table: 'rent_requests', source_id: rr.id,
            description: `Manual collection: ${trimmedReason}`, currency: 'UGX',
            transaction_date: tenantTxDate,
          },
          {
            user_id: rr.tenant_id, ledger_scope: 'platform', direction: 'cash_in',
            amount: tenantDeducted, category: 'tenant_repayment',
            source_table: 'rent_requests', source_id: rr.id,
            description: `Manual collection received from tenant`, currency: 'UGX',
            transaction_date: tenantTxDate,
          },
        ],
      });

      if (tenantRpcErr) {
        console.error("[manual-collect-rent] Tenant RPC error:", tenantRpcErr);
        return new Response(JSON.stringify({ error: "Failed to deduct from tenant wallet. Try again." }), { status: 409, headers: corsContentType });
      }

      shortfall -= tenantDeducted;

      await supabase.from("notifications").insert({
        user_id: rr.tenant_id, title: "💳 Rent Collected",
        message: `UGX ${tenantDeducted.toLocaleString()} was collected from your wallet for rent repayment by the manager.`,
        type: "info", metadata: { rent_request_id, amount: tenantDeducted, source: "manual_collection" },
      });
    }

    // Agent wallet for remaining shortfall via balanced RPC
    if (shortfall > 0 && rr.agent_id) {
      const { data: agentWallet } = await supabase.from("wallets").select("balance").eq("user_id", rr.agent_id).single();
      const agentBalance = Number(agentWallet?.balance || 0);

      if (agentBalance > 0) {
        agentDeducted = Math.min(agentBalance, shortfall);

        const agentTxDate = new Date().toISOString();
        const { error: agentRpcErr } = await supabase.rpc('create_ledger_transaction', {
          entries: [
            {
              user_id: rr.agent_id, ledger_scope: 'wallet', direction: 'cash_out',
              amount: agentDeducted, category: 'tenant_repayment',
              source_table: 'rent_requests', source_id: rr.id,
              description: `Manual collection (agent share for ${tenantName}): ${trimmedReason}`, currency: 'UGX',
              transaction_date: agentTxDate,
            },
            {
              user_id: rr.agent_id, ledger_scope: 'platform', direction: 'cash_in',
              amount: agentDeducted, category: 'tenant_repayment',
              source_table: 'rent_requests', source_id: rr.id,
              description: `Manual collection received from agent for ${tenantName}`, currency: 'UGX',
              transaction_date: agentTxDate,
            },
          ],
        });

        if (!agentRpcErr) {
          shortfall -= agentDeducted;
          await supabase.from("notifications").insert({
            user_id: rr.agent_id, title: "💳 Agent Wallet Charged for Tenant",
            message: `UGX ${agentDeducted.toLocaleString()} was collected from your wallet to cover ${tenantName}'s rent repayment.`,
            type: "warning", metadata: { rent_request_id, tenant_name: tenantName, amount: agentDeducted },
          });
        } else {
          console.error("[manual-collect-rent] Agent RPC error:", agentRpcErr);
        }
      }
    }

    const totalCollected = tenantDeducted + agentDeducted;
    if (totalCollected === 0) {
      return new Response(JSON.stringify({ error: "Both tenant and agent wallets have insufficient funds" }), { status: 400, headers: corsContentType });
    }

    // Try the Treasury waterfall first; fall back to legacy repayment so a
    // missing funding-side L7 credit never blocks the tenant's payment.
    try {
      const { error: waterfallErr } = await supabase.rpc("record_rent_request_repayment_v2", {
        p_tenant_id: rr.tenant_id,
        p_amount: totalCollected,
        p_source_table: "manual_collect_rent",
        p_source_id: crypto.randomUUID(),
      });
      if (waterfallErr) throw waterfallErr;
      console.log('[manual-collect-rent] Treasury waterfall recorded for rent request', rent_request_id);
    } catch (waterfallErr: any) {
      console.error('[manual-collect-rent] Treasury waterfall failed, falling back to legacy repayment:', waterfallErr?.message || waterfallErr);
      await supabase.rpc("record_rent_request_repayment", { p_tenant_id: rr.tenant_id, p_amount: totalCollected });
    }

    const commission = Math.round(totalCollected * 0.10);
    if (commission > 0 && rr.agent_id) {
      const commissionTxDate = new Date().toISOString();
      const { error: commErr } = await supabase.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: rr.agent_id, ledger_scope: 'wallet', direction: 'cash_in',
            amount: commission, category: 'agent_commission_earned',
            source_table: 'rent_requests', source_id: rr.id,
            description: `10% commission on manual rent collection for ${tenantName}`,
            currency: 'UGX', transaction_date: commissionTxDate,
          },
          {
            user_id: rr.agent_id, ledger_scope: 'platform', direction: 'cash_out',
            amount: commission, category: 'agent_commission_earned',
            source_table: 'rent_requests', source_id: rr.id,
            description: `Commission expense: manual collection for ${tenantName}`,
            currency: 'UGX', transaction_date: commissionTxDate,
          },
        ],
        idempotency_key: `manual-collect-commission-${rr.id}-${commissionTxDate}`,
      });
      if (commErr) console.error("[manual-collect-rent] Commission ledger error:", commErr);
    }

    const remainingBalance = outstanding - totalCollected;
    if (tenantPhone) {
      const smsMessage = [
        `WELILE: Dear ${tenantName}, UGX ${totalCollected.toLocaleString()} has been paid towards your rent by ${agentName}.`,
        remainingBalance > 0 ? `Balance remaining: UGX ${remainingBalance.toLocaleString()}.` : `Your rent is now fully paid! Thank you.`,
        `Did you know? With WELILE, you can access up to UGX 30,000,000 in credit. Ask your agent for details!`,
        `Ref: ${rent_request_id.slice(0, 8)}`,
      ].join("\n");
      sendSMS(tenantPhone, smsMessage).catch(e => console.error("[manual-collect-rent] SMS error:", e));
    }

    await supabase.from("audit_logs").insert({
      user_id: user.id, action_type: "manual_rent_collection", table_name: "rent_requests", record_id: rent_request_id,
      metadata: { reason: trimmedReason, tenant_id: rr.tenant_id, tenant_name: tenantName, agent_id: rr.agent_id,
        total_collected: totalCollected, tenant_deducted: tenantDeducted, agent_deducted: agentDeducted,
        commission_paid: commission },
    });

    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "🏠 Manual Rent Collection", body: "Activity: rent collected", url: "/dashboard/manager" }),
    }).catch(() => {});

    return new Response(JSON.stringify({
      success: true, total_collected: totalCollected, tenant_deducted: tenantDeducted,
      agent_deducted: agentDeducted, remaining_shortfall: shortfall, tenant_name: tenantName,
      commission_paid: commission, requested_amount: requestedAmount,
      is_partial: isPartial || (totalCollected < requestedAmount), remaining_balance: remainingBalance,
    }), { status: 200, headers: corsContentType });

  } catch (error) {
    console.error("[manual-collect-rent] Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: corsContentType });
  }
});
