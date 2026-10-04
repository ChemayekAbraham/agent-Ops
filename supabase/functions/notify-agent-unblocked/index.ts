import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

function formatUGX(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "notify-agent-unblocked" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notify-agent-unblocked] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const to = formatPhoneInternational(phone);
  const body = new URLSearchParams({ username, from: "WELILE", to, message });
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const raw = await res.text();
    console.log(`[notify-agent-unblocked] AT response (${res.status}) for ${to}:`, raw);
    const data = JSON.parse(raw);
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[notify-agent-unblocked] AT error", err);
    return false;
  }
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

    const { event_id, agent_id, paid_today, expected_daily, ratio_pct, active_count } = await req.json();
    if (!event_id || !agent_id) {
      return new Response(JSON.stringify({ error: "Missing event_id/agent_id" }), {
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
      .select("full_name, phone")
      .eq("id", agent_id)
      .maybeSingle();

    const phone = profile?.phone;
    const name = (profile?.full_name || "Agent").split(" ")[0];

    let sent = false;
    if (phone) {
      const msg =
        `Hi ${name}, you are unblocked. ` +
        `Today you collected UGX ${formatUGX(paid_today)} of UGX ${formatUGX(expected_daily)} ` +
        `(${Math.round(ratio_pct)}%) across ${active_count} active rents. ` +
        `You can now post new rent requests. — Welile`;
      sent = await sendSMS(phone, msg);
    } else {
      console.warn(`[notify-agent-unblocked] Agent ${agent_id} has no phone`);
    }

    await admin
      .from("agent_eligibility_unblock_events")
      .update({ sms_sent: sent, sms_sent_at: new Date().toISOString() })
      .eq("id", event_id);

    return new Response(JSON.stringify({ success: true, sms_sent: sent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-agent-unblocked] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});