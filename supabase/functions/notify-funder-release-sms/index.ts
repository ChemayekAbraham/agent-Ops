import "../_shared/smsFooterInterceptor.ts";
// Drains funder_release_sms: tenant SMS, landlord SMS, and Zoe's WhatsApp to
// the agent. WhatsApp uses the approved template zoe_agent_landlord_float.
// If that send fails, the same words go out as SMS. An uncertain WhatsApp
// delivery is not followed by SMS.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { maskPhone } from "../_shared/landlordFloatSms.ts";
import { sendWhatsApp } from "../_shared/whatsapp.ts";
import {
  confirmYoolaDelivery,
  extractYoolaMessageId,
} from "../_shared/yoolaDeliveryConfirm.ts";

const ZOE_TEMPLATE = "zoe_agent_landlord_float";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ATTEMPTS = 4;

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function normalizePhone(raw: string): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  if (!d.startsWith("256") && d.length === 9) d = "256" + d;
  return "+" + d;
}

async function sendViaYoola(phone: string, message: string) {
  const apiKey = (Deno.env.get("YOOLA_SMS_API_KEY") || "").trim();
  if (!apiKey) return { ok: false, reason: "yoola_not_configured" };
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        phone: phone.replace(/\D/g, ""),
        message,
        api_key: apiKey,
        sender: "WELILE",
      }),
    });
    const text = await res.text();
    let data: Record<string, unknown> | null = null;
    try { data = JSON.parse(text); } catch { /* raw */ }
    const status = String(data?.status ?? "").toLowerCase();
    const accepted = res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    if (!accepted) return { ok: false, reason: `yoola_${res.status}_${status || "rejected"}` };
    const messageId = extractYoolaMessageId(data);
    const confirmation = await confirmYoolaDelivery(messageId, { attempts: 4, delayMs: 2500 });
    if (confirmation.outcome === "delivered") return { ok: true };
    return { ok: true, unconfirmed: `yoola_unconfirmed_${confirmation.detail ?? confirmation.outcome}` };
  } catch (e) {
    console.error("[funder-release-sms] Yoola error:", e);
    return { ok: false, reason: "network_error" };
  }
}

async function sendViaAfricasTalking(phone: string, message: string) {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return { ok: false, reason: "missing_credentials" };
  const baseUrl = username.toLowerCase() === "sandbox"
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ username, from: "WELILE", to: phone, message }).toString(),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `at_http_${res.status}` };
  } catch (e) {
    console.error("[funder-release-sms] AT error:", e);
    return { ok: false, reason: "network_error" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: rows, error } = await admin
    .from("funder_release_sms")
    .select("id, rent_request_id, phone, message, attempts, audience, channel, fallback_message, template_params")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) return json(500, { error: error.message });
  if (!rows?.length) return json(200, { processed: 0, sent: 0, failed: 0 });

  let sent = 0;
  let failed = 0;
  const logRows: Record<string, unknown>[] = [];

  for (const row of rows) {
    const phone = row.phone ? normalizePhone(row.phone) : "";
    const message = String(row.message || "");
    const channel = String(row.channel || "sms");
    const audience = String(row.audience || "tenant");
    const loggedPhone = audience === "tenant" && channel === "sms"
      ? phone
      : (maskPhone(phone) || "hidden");
    if (!phone || phone.replace(/\D/g, "").length < 12 || !message) {
      failed++;
      await admin.from("funder_release_sms")
        .update({ status: "failed", attempts: (row.attempts || 0) + 1, last_error: "missing_phone" })
        .eq("id", row.id);
      continue;
    }

    let outcome: { ok: boolean; reason?: string; unconfirmed?: string } = { ok: false, reason: "not_sent" };
    let provider = "yoola";
    let sentMessage = message;

    if (channel === "whatsapp") {
      const params = Array.isArray(row.template_params)
        ? row.template_params.map((part: unknown) => String(part ?? ""))
        : [];
      const wa = await sendWhatsApp(phone, message, {
        templateName: ZOE_TEMPLATE,
        templateLanguage: "en",
        templateParameters: params,
      });
      if (wa.ok) {
        outcome = { ok: true };
        provider = wa.provider || "meta";
      } else if (wa.error === "meta_delivery_unknown") {
        failed++;
        await admin.from("funder_release_sms")
          .update({ status: "failed", attempts: MAX_ATTEMPTS, last_error: "meta_delivery_unknown" })
          .eq("id", row.id);
        logRows.push({
          recipient_phone: loggedPhone,
          message,
          provider: "meta",
          status: "failed",
          error: "meta_delivery_unknown",
          reference_id: row.rent_request_id,
          source: "notify-funder-release-sms",
        });
        continue;
      } else {
        sentMessage = String(row.fallback_message || message);
        outcome = await sendViaYoola(phone, sentMessage);
        provider = "yoola";
        if (!outcome.ok) {
          outcome = await sendViaAfricasTalking(phone, sentMessage);
          provider = "africastalking";
        }
        if (outcome.ok) outcome = { ...outcome, unconfirmed: outcome.unconfirmed ?? `whatsapp_${wa.error || "failed"}_sms_sent` };
      }
    } else {
      outcome = await sendViaYoola(phone, message);
      provider = "yoola";
      if (!outcome.ok) {
        outcome = await sendViaAfricasTalking(phone, message);
        provider = "africastalking";
      }
    }

    logRows.push({
      recipient_phone: loggedPhone,
      message: sentMessage,
      provider,
      status: outcome.ok ? "accepted" : "failed",
      error: outcome.ok ? (outcome.unconfirmed ?? null) : (outcome.reason ?? null),
      reference_id: row.rent_request_id,
      source: "notify-funder-release-sms",
    });

    if (outcome.ok) {
      sent++;
      await admin.from("funder_release_sms")
        .update({ status: "sent", sent_at: new Date().toISOString(), last_error: outcome.unconfirmed ?? null })
        .eq("id", row.id);
    } else {
      failed++;
      const attempts = (row.attempts || 0) + 1;
      await admin.from("funder_release_sms")
        .update({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          last_error: outcome.reason ?? "send_failed",
        })
        .eq("id", row.id);
    }
  }

  if (logRows.length) {
    const { error: logErr } = await admin.from("sms_delivery_log").insert(logRows);
    if (logErr) console.warn("[funder-release-sms] delivery log insert failed:", logErr.message);
  }

  return json(200, { processed: rows.length, sent, failed });
});
