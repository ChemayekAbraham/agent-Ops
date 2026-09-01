import "../_shared/smsFooterInterceptor.ts";
// Notifies agents that partner-funded landlord float has arrived for a landlord.
//
// Everything is DB-backed: the queue rows are written by
// public.psm_disburse_landlord_float() inside the Partner Ops approval
// transaction. This worker only drains `v_partner_float_notice_queue` (a single
// round trip that already carries the agent's name + phone, so no N+1 lookups)
// and marks each row sent/failed.
//
// The SMS deliberately NEVER names the funding partner.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  confirmYoolaDelivery,
  extractYoolaMessageId,
} from "../_shared/yoolaDeliveryConfirm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

/** Agent dashboard deep link included in every float-arrival SMS. */
const AGENT_DASHBOARD_URL = "https://welileapp.com/dashboard/agent";

/** Agent-facing copy. No partner identity is ever disclosed. */
function buildMessage(row: {
  agent_name: string | null;
  landlord_name: string;
  amount: number;
  tenant_count: number;
}): string {
  const first = String(row.agent_name || "Agent").split(" ")[0];
  const tenants = row.tenant_count === 1 ? "1 tenant" : `${row.tenant_count} tenants`;
  return (
    `WELILE: ${first}, ${ugx(row.amount)} landlord float has been released to you for ` +
    `${row.landlord_name} (${tenants}). The rent capital has been approved and is now in your ` +
    `Landlord Payout Float. Pay the landlord now and submit the TID/receipt: ${AGENT_DASHBOARD_URL}`
  );
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
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* raw */ }
    const status = String(data?.status ?? "").toLowerCase();
    const accepted = res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    if (!accepted) {
      return { ok: false, reason: `yoola_${res.status}_${status || "rejected"}` };
    }
    // Yoola accepting the request is not proof of handset delivery, but a
    // second send through Africa's Talking after an accepted request delivers
    // the SAME message twice (observed in production). So: only fail over when
    // Yoola REJECTED the request. An accepted-but-unconfirmed send is reported
    // as delivered with a note instead of being duplicated.
    const messageId = extractYoolaMessageId(data);
    const confirmation = await confirmYoolaDelivery(messageId, { attempts: 4, delayMs: 2500 });
    if (confirmation.outcome === "delivered") return { ok: true };
    return {
      ok: true,
      unconfirmed: `yoola_unconfirmed_${confirmation.detail ?? confirmation.outcome}`,
    };

  } catch (e) {
    console.error("[partner-float-sms] Yoola error:", e);
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
    console.error("[partner-float-sms] AT error:", e);
    return { ok: false, reason: "network_error" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const commitmentId = body?.commitment_id ? String(body.commitment_id) : null;
  const limit = Math.min(Number(body?.limit) || 100, 300);

  let q = admin
    .from("v_partner_float_notice_queue")
    .select("id, agent_id, agent_name, agent_phone, landlord_name, amount, tenant_count, commitment_id")
    .eq("status", "pending")
    .lt("attempts", 4)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (commitmentId) q = q.eq("commitment_id", commitmentId);

  const { data: rows, error } = await q;
  if (error) return json(500, { error: error.message });
  if (!rows?.length) return json(200, { processed: 0, sent: 0, failed: 0 });

  let sent = 0;
  let failed = 0;
  const logRows: Record<string, unknown>[] = [];

  for (const row of rows as any[]) {
    const phone = row.agent_phone ? normalizePhone(row.agent_phone) : "";
    const message = buildMessage(row);

    if (!phone || phone.replace(/\D/g, "").length < 12) {
      failed++;
      await admin.from("partner_float_agent_notices")
        .update({ status: "failed", attempts: (row.attempts || 0) + 1, last_error: "missing_agent_phone" })
        .eq("id", row.id);
      continue;
    }

    let outcome: any = await sendViaYoola(phone, message);
    let provider = "yoola";
    if (!outcome.ok) {
      outcome = await sendViaAfricasTalking(phone, message);
      provider = "africastalking";
    }

    logRows.push({
      recipient_phone: phone,
      recipient_user_id: row.agent_id,
      recipient_name: row.agent_name,
      message,
      provider,
      status: outcome.ok ? "accepted" : "failed",
      error: outcome.ok ? (outcome.unconfirmed ?? null) : (outcome as any).reason ?? null,
      reference_id: row.id,
      source: "notify-partner-float-agents",
    });


    if (outcome.ok) {
      sent++;
      await admin.from("partner_float_agent_notices")
        .update({ status: "sent", provider, sent_at: new Date().toISOString(), last_error: outcome.unconfirmed ?? null })
        .eq("id", row.id);

    } else {
      failed++;
      await admin.from("partner_float_agent_notices")
        .update({
          status: "pending",
          attempts: (row.attempts || 0) + 1,
          last_error: (outcome as any).reason ?? "send_failed",
        })
        .eq("id", row.id);
    }
  }

  if (logRows.length) {
    const { error: logErr } = await admin.from("sms_delivery_log").insert(logRows);
    if (logErr) console.warn("[partner-float-sms] delivery log insert failed:", logErr.message);
  }

  return json(200, { processed: rows.length, sent, failed });
});
