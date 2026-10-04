// Cron-triggered SLA monitor — escalates landlord payouts that breach 5-min deadline
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE);
  const nowIso = new Date().toISOString();

  const { data: breached, error } = await adminClient
    .from("landlord_payouts")
    .select("id, agent_id, amount, status, sla_deadline")
    .in("status", ["otp_verified", "disbursing"])
    .lt("sla_deadline", nowIso);

  if (error) {
    console.error("[sla-monitor] query failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let escalated = 0;
  for (const row of breached ?? []) {
    try {
      // Refund the float (payout never settled)
      await adminClient.rpc("refund_agent_float_for_payout", {
        p_payout_id: row.id,
        p_reason: "SLA_BREACH_AUTO_ESCALATE_BY_CRON",
      });

      await adminClient.from("landlord_payouts").update({
        status: "escalated",
        escalated_at: nowIso,
        escalated_reason: "5-minute SLA breached — escalated by automated monitor",
      }).eq("id", row.id);

      await logSystemEvent(
        adminClient,
        "landlord_payout_sla_breach",
        row.agent_id,
        "landlord_payout",
        row.id,
        { amount: row.amount, prior_status: row.status },
      );
      escalated++;
    } catch (e) {
      console.error(`[sla-monitor] failed to escalate ${row.id}:`, e);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    checked: breached?.length ?? 0,
    escalated,
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
