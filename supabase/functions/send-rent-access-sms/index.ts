import "../_shared/smsFooterInterceptor.ts";
// Sends a short SMS to a tenant pointing at their branded Welile
// "Rent Money You Can Get" card. SMS cannot carry the image inline,
// so we deliver a short link to the public limit page which renders
// the same fully-branded card the agent saw.
//
// Two invocation modes:
//  - manual:    agent taps "Share via SMS" in the share dialog
//  - allocation: fired automatically after a successful agent allocation

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isPhoneBlocked } from "../_shared/smsExceptions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

function formatUGX(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return `UGX ${v.toLocaleString("en-UG")}`;
}

// Digits-only phone with country code, no leading "+" (e.g. "256704487563").
// Shape used by both Yoola and LANA.
function formatPhoneDigits(phone: string): string {
  return formatPhoneInternational(phone).replace(/^\+/, "");
}

// ── SMS provider chain: Yoola (primary) → Africa's Talking → LANA ──
// Each provider is tried only if the previous is unconfigured or rejects.
async function sendViaYoola(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return false;
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // "WELILE" is the registered Yoola sender ID and must be set explicitly
      // so tenants see the brand name instead of a generic gateway sender.
      body: JSON.stringify({ phone: formatPhoneDigits(phone), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    console.log(`[send-rent-access-sms] Yoola (${res.status}):`, text);
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const status = String(data?.status ?? "").toLowerCase();
    if (res.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued")) return true;
    if (res.ok && !data?.error && status === "") return true;
    return false;
  } catch (err) {
    console.error("[send-rent-access-sms] Yoola failed:", err);
    return false;
  }
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return false;
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const to = formatPhoneInternational(phone);
  if (!to) return false;
  try {
    const body = new URLSearchParams({ username, from: "WELILE", to, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch {
      console.error("[send-rent-access-sms] Non-JSON AT response:", raw);
      return false;
    }
    const recipients = data?.SMSMessageData?.Recipients || [];
    const ok = recipients.some((r: any) => r.statusCode === 100 || r.statusCode === 101);
    console.log(`[send-rent-access-sms] AT to=${to} ok=${ok} recipients=${JSON.stringify(recipients)}`);
    return ok;
  } catch (err) {
    console.error("[send-rent-access-sms] AT send failed:", err);
    return false;
  }
}

async function sendViaLana(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ phone: String(formatPhoneDigits(phone)), sender_id: "WELILE", message }).toString(),
    });
    const text = await res.text();
    console.log(`[send-rent-access-sms] LANA (${res.status}):`, text);
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const status = String(data?.status ?? "").toLowerCase();
    return res.ok && (data?.status === true || status === "success" || status === "true" || status === "ok" || status === "sent" || status === "queued");
  } catch (err) {
    console.error("[send-rent-access-sms] LANA failed:", err);
    return false;
  }
}

async function sendSMS(phone: string, message: string): Promise<{ ok: boolean; provider: string | null }> {
  const to = formatPhoneInternational(phone);
  if (!to) return { ok: false, provider: null };
  if (await sendViaYoola(phone, message)) return { ok: true, provider: "yoola" };
  console.warn("[send-rent-access-sms] Yoola not accepted; trying Africa's Talking");
  if (await sendViaAfricasTalking(phone, message)) return { ok: true, provider: "africastalking" };
  console.warn("[send-rent-access-sms] AT not accepted; trying LANA");
  if (await sendViaLana(phone, message)) return { ok: true, provider: "lana" };
  console.error("[send-rent-access-sms] all providers failed");
  return { ok: false, provider: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const adminClient = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userResp, error: userErr } =
      await adminClient.auth.getUser(token);
    if (userErr || !userResp?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const {
      tenant_id,
      tenant_name,
      tenant_phone,
      share_url,
      limit_amount,
      allocation_amount,
      paid_amount,
      remaining_balance,
      mode, // 'manual' | 'allocation'
    } = body || {};

    if (!tenant_phone || !tenant_name) {
      return new Response(
        JSON.stringify({ error: "tenant_phone and tenant_name are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const firstName = String(tenant_name).split(" ")[0];
    const limitText =
      Number(limit_amount) > 0 ? formatUGX(Number(limit_amount)) : null;
    const paidNum = Number(paid_amount ?? allocation_amount) || 0;
    const remainingNum = Number(remaining_balance);
    const hasRemaining = Number.isFinite(remainingNum) && remainingNum >= 0;

    let message: string;
    if (mode === "allocation" && paidNum > 0) {
      // Short branded copy for agent float allocations / tenant payments.
      const parts = [
        `WELILE: Hi ${firstName}, paid ${formatUGX(paidNum)}.`,
        hasRemaining ? `Balance ${formatUGX(remainingNum)}.` : null,
        share_url ? `Card: ${share_url}` : null,
      ].filter(Boolean);
      message = parts.join(" ");
    } else {
      // Manual share — short card-link copy.
      const parts = [
        `WELILE: Hi ${firstName},`,
        limitText ? `get up to ${limitText} for rent.` : `see your rent money.`,
        share_url ? `Card: ${share_url}` : null,
      ].filter(Boolean);
      message = parts.join(" ");
    }

    // Honour CTO-managed SMS exceptions for this message type.
    const blocked = await isPhoneBlocked(adminClient, tenant_phone, "rent_access");
    const result = blocked ? { ok: false, provider: null } : await sendSMS(tenant_phone, message);
    const ok = result.ok;

    // Every attempt gets a sms_delivery_log row — previously this function
    // only wrote a best-effort system_events row (skipped entirely when no
    // tenant_id was passed), leaving Yoola spend reporting blind to every
    // rent-access-limit SMS sent from here.
    try {
      await adminClient.from("sms_delivery_log").insert({
        recipient_phone: tenant_phone,
        recipient_user_id: tenant_id ?? null,
        recipient_name: tenant_name ?? null,
        message,
        status: ok ? "sent" : "failed",
        provider: result.provider ?? (blocked ? "none" : "none"),
        error: blocked ? "blocked_by_sms_exception" : (ok ? null : "all_providers_failed"),
        source: `rent_access_sms:${mode || "manual"}`,
      });
    } catch (e) {
      console.warn("[send-rent-access-sms] sms_delivery_log insert failed", e);
    }

    // Best-effort: log the send as a system event for auditability.
    if (tenant_id) {
      try {
        await userClient.from("system_events").insert({
          event_type: "rent_access_limit.sms.sent",
          actor_id: userResp.user.id,
          subject_id: tenant_id,
          payload: {
            mode: mode || "manual",
            success: ok,
            limit_amount: Number(limit_amount) || null,
            allocation_amount: Number(allocation_amount) || null,
            paid_amount: paidNum || null,
            remaining_balance: hasRemaining ? remainingNum : null,
            share_url: share_url || null,
          },
        });
      } catch (e) {
        console.warn("[send-rent-access-sms] system_events insert failed", e);
      }
    }

    return new Response(JSON.stringify({ success: ok }), {
      status: ok ? 200 : 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[send-rent-access-sms] error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});