import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<{ ok: boolean; error?: string }> {
  if (await attemptYoolaPrimary(phone, message, { source: "notify-email-routing" })) return { ok: true };
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return { ok: false, error: "Missing AT credentials" };

  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const formattedPhone = formatPhoneInternational(phone);
  if (!formattedPhone) return { ok: false, error: "Invalid phone" };

  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formattedPhone,      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const rawText = await res.text();
    let data: any;
    try { data = JSON.parse(rawText); } catch { return { ok: false, error: `Non-JSON AT response (${res.status})` }; }
    const recipients = data?.SMSMessageData?.Recipients || [];
    const ok = recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
    return ok ? { ok: true } : { ok: false, error: JSON.stringify(recipients) || `AT status ${res.status}` };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceKey);

  try {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["cfo", "operations", "manager", "super_admin"]);
    if (!roles?.length) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { phone, target_user_name, amount, route, reference_id, from_label, transaction_id, reversal } = await req.json();
    // SMS is best-effort: a missing phone (no number on file for the target
    // user) must NOT surface as a hard error to the caller — skip gracefully.
    if (!phone) {
      return new Response(JSON.stringify({ success: false, skipped: true, error: "No phone on file" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!amount || !route) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const routeLabel = route === "operational_float" ? "Operational Float" : "Personal Deposit";
    const formattedAmount = `UGX ${Number(amount).toLocaleString()}`;
    // Core first; optional lines (TID, From, Ref) are added only while the
    // text stays within 143 chars (160 minus the central support footer).
    const msgLines = [
      reversal
        ? `WELILE: ${formattedAmount} credited to your ${routeLabel} was REVERSED and re-routed. Unexpected? Contact support.`
        : `WELILE: ${formattedAmount} routed to your wallet as ${routeLabel}.`,
    ];
    const optional = [
      transaction_id ? `TID: ${transaction_id}` : "",
      from_label ? `From: ${from_label}` : "",
      reference_id ? `Ref: ${reference_id}` : "",
    ];
    for (const line of optional) {
      if (line && [...msgLines, line].join("\n").length <= 143) msgLines.push(line);
    }
    const message = msgLines.join("\n");

    const result = await sendSMS(phone, message);
    return new Response(JSON.stringify({ success: result.ok, error: result.error || null }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});