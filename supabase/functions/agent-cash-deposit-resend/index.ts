import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
// Cash-with-agent deposit — Resend OTP.
// The depositor can request a fresh confirmation code for an existing
// pending session. We generate a new PIN, refresh the expiry, and re-send
// the SMS to the agent.
import { confirmYoolaDelivery, extractYoolaMessageId } from "../_shared/yoolaDeliveryConfirm.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function gen4DigitPin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return String(n).padStart(4, "0");
}

function normalizePhone(raw: string): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  if (!d.startsWith("256") && d.length === 9) d = "256" + d;
  return "+" + d;
}

// Yoola is the PRIMARY SMS sender; Africa's Talking is the fallback.
async function sendViaYoola(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = (Deno.env.get("YOOLA_SMS_API_KEY") || "").trim();
  if (!apiKey) return { ok: false, reason: "yoola_not_configured" };
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // "WELILE" is the registered Yoola sender ID and must be set explicitly.
      body: JSON.stringify({ phone: String(phone || "").replace(/\D/g, ""), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    const status = String(data?.status ?? "").toLowerCase();
    // Treat any successful HTTP response that Yoola did not explicitly reject as
    // "accepted" so Africa's Talking never double-sends after a real delivery.
    const accepted =
      res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    if (!accepted) return { ok: false, reason: `yoola_${res.status}_${status || "rejected"}` };
    // Acceptance is not delivery: the cash code is time-critical, so wait for
    // Yoola's delivery report and hand over to Africa's Talking if the handset
    // is not confirmed inside the window.
    const confirmation = await confirmYoolaDelivery(extractYoolaMessageId(data));
    if (confirmation.outcome === "delivered") return { ok: true };
    console.warn("[agent-cash-resend] Yoola accepted but did not confirm delivery:", confirmation.detail);
    return { ok: false, reason: `yoola_unconfirmed_${confirmation.detail ?? confirmation.outcome}` };
  } catch (e) {
    console.error("[agent-cash-resend] Yoola error:", e);
    return { ok: false, reason: "network_error" };
  }
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.warn("[agent-cash-resend] Missing Africa's Talking creds — skipping AT");
    return { ok: false, reason: "missing_credentials" };
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const params = new URLSearchParams({ username, from: "WELILE", to: phone, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `at_http_${res.status}` };
  } catch (e) {
    console.error("[agent-cash-resend] AT SMS error:", e);
    return { ok: false, reason: "network_error" };
  }
}

interface ProviderAttempt {
  provider: string;
  accepted: boolean;
  reason?: string;
  started_at: string;
  finished_at: string;
  attempted: boolean;
}
interface SmsOutcome {
  ok: boolean;
  reason?: string;
  provider?: string;
  attempts: ProviderAttempt[];
}
function wasSkipped(reason?: string): boolean {
  return reason === "missing_credentials" ||
    (typeof reason === "string" && reason.endsWith("not_configured"));
}

// Yoola (primary) → Africa's Talking (fallback), one at a time. Every attempt
// is timestamped so the delivery log proves there is never a double-send.
async function sendSms(phone: string, message: string): Promise<SmsOutcome> {
  const attempts: ProviderAttempt[] = [];
  const run = async (provider: string, fn: () => Promise<{ ok: boolean; reason?: string }>) => {
    const started_at = new Date().toISOString();
    const r = await fn();
    const finished_at = new Date().toISOString();
    attempts.push({ provider, accepted: r.ok, reason: r.reason, started_at, finished_at, attempted: !wasSkipped(r.reason) });
    return r;
  };
  const yoola = await run("yoola", () => sendViaYoola(phone, message));
  if (yoola.ok) return { ok: true, provider: "yoola", attempts };
  console.warn("[agent-cash-resend] Yoola not accepted — falling back to Africa's Talking");
  const at = await run("africastalking", () => sendViaAfricasTalking(phone, message));
  if (at.ok) return { ok: true, provider: "africastalking", attempts };
  const reason = (yoola.reason && yoola.reason !== "yoola_not_configured") ? yoola.reason : at.reason;
  return { ok: false, reason, attempts };
}

async function logSmsAttempts(
  admin: ReturnType<typeof createClient>,
  ctx: { phone: string; message: string; userId?: string | null; name?: string | null; referenceId?: string | null; source: string },
  outcome: SmsOutcome,
): Promise<void> {
  try {
    if (!outcome.attempts.length) return;
    const rows = outcome.attempts.map((a, i) => ({
      recipient_phone: ctx.phone,
      recipient_user_id: ctx.userId ?? null,
      recipient_name: ctx.name ?? null,
      message: ctx.message,
      provider: a.provider,
      status: a.accepted ? "accepted" : (a.attempted ? "failed" : "skipped"),
      error: a.accepted ? null : (a.reason ?? null),
      reference_id: ctx.referenceId ?? null,
      source: ctx.source,
      provider_response: {
        attempt_sequence: i + 1,
        total_attempts: outcome.attempts.length,
        started_at: a.started_at,
        finished_at: a.finished_at,
        reason: a.reason ?? null,
        final_provider: outcome.provider ?? null,
        final_accepted: outcome.ok,
      },
    }));
    await admin.from("sms_delivery_log").insert(rows);
  } catch (e) {
    console.warn("[agent-cash-resend] sms_delivery_log insert failed (non-critical):", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) return json(401, { error: "Unauthorized" });
    const depositor = authData.user;

    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(sessionId)) {
      return json(400, { error: "invalid_request", message: "Missing deposit reference" });
    }

    // ── Load and validate the session ──
    const { data: session, error: sErr } = await admin
      .from("agent_cash_deposit_sessions")
      .select("id, depositor_id, depositor_name, agent_id, agent_phone, amount, pin, status, expires_at")
      .eq("id", sessionId)
      .eq("depositor_id", depositor.id)
      .maybeSingle();

    if (sErr || !session) {
      return json(404, { error: "not_found", message: "No pending cash deposit found." });
    }
    const s = session as any;

    if (s.status !== "pending") {
      return json(410, { error: "not_active", message: "This deposit is no longer active. Please start a new one." });
    }

    // ── Refresh PIN and expiry ──
    const newPin = gen4DigitPin();
    const newExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { error: updErr } = await admin
      .from("agent_cash_deposit_sessions")
      .update({ pin: newPin, expires_at: newExpiresAt, attempts: 0 })
      .eq("id", s.id);

    if (updErr) {
      console.error("[agent-cash-resend] update failed", updErr);
      return json(500, { error: "update_failed", message: "Could not refresh the confirmation code" });
    }

    // ── Re-send SMS to the agent ──
    const agentPhoneForSms = normalizePhone(s.agent_phone ?? "");
    const smsBody = `Welile: ${s.depositor_name ?? "A user"} is collecting UGX ${Number(s.amount).toLocaleString()} cash from your float. NEW confirmation code: ${newPin}. Share it ONLY after handing over the cash. Your float will reduce by this amount.`;
    const smsOutcome = await sendSms(agentPhoneForSms, smsBody);
    await logSmsAttempts(admin, {
      phone: agentPhoneForSms,
      message: smsBody,
      userId: s.agent_id ?? null,
      referenceId: s.id ?? null,
      source: "agent-cash-deposit-resend",
    }, smsOutcome);
    const smsSent = smsOutcome.ok;

    return json(200, {
      ok: true,
      session_id: s.id,
      expires_at: newExpiresAt,
      sms_sent: smsSent,
    });
  } catch (e) {
    console.error("[agent-cash-resend] error", e);
    return json(500, { error: "server_error", message: String((e as Error)?.message ?? e) });
  }
});
