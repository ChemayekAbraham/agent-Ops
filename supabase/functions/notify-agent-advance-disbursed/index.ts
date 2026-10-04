import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatUGX(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { agent_id, amount, request_id } = await req.json();
    if (!agent_id || !amount || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "Missing agent_id/amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profile } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .eq("id", agent_id)
      .maybeSingle();

    const phone = profile?.phone;
    const name = (profile?.full_name || "Agent").split(" ")[0];

    if (!phone) {
      console.warn(`[notify-agent-advance-disbursed] Agent ${agent_id} has no phone`);
      return new Response(JSON.stringify({ success: true, sms_sent: false, reason: "no_phone" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const msg =
      `Hi ${name}, your Welile agent advance of UGX ${formatUGX(Number(amount))} ` +
      `has been disbursed to your wallet. Daily deductions will apply per your plan. — Welile`;

    const sent = await sendSMS(phone, msg, {
      admin,
      source: "notify-agent-advance-disbursed",
      reference_id: request_id ?? null,
      recipient_user_id: profile?.id ?? agent_id,
      recipient_name: profile?.full_name ?? null,
      idempotencyKey: request_id ? `advance-disbursed-${request_id}` : null,
    }).catch((e) => {
      console.error("[notify-agent-advance-disbursed] SMS failed:", (e as Error).message);
      return false;
    });

    return new Response(JSON.stringify({ success: true, sms_sent: sent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-agent-advance-disbursed] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});