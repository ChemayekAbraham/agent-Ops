import "../_shared/smsFooterInterceptor.ts";
// Drains funder_release_sms. Rows are written when a partner release has a
// tenant phone and no tenant email. The message text is already stored.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  confirmYoolaDelivery,
  extractYoolaMessageId,
} from "../_shared/yoolaDeliveryConfirm.ts";

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
    .select("id, rent_request_id, phone, message, attempts")
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
    if (!phone || phone.replace(/\D/g, "").length < 12 || !message) {
      failed++;
      await admin.from("funder_release_sms")
        .update({ status: "failed", attempts: (row.attempts || 0) + 1, last_error: "missing_phone" })
        .eq("id", row.id);
      continue;
    }

    let outcome: { ok: boolean; reason?: string; unconfirmed?: string } = await sendViaYoola(phone, message);
    let provider = "yoola";
    if (!outcome.ok) {
      outcome = await sendViaAfricasTalking(phone, message);
      provider = "africastalking";
    }

    logRows.push({
      recipient_phone: phone,
      message,
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
