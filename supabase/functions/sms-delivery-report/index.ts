// Africa's Talking Delivery Report (DLR) callback.
// AT POSTs a delivery report per recipient once the carrier confirms the final
// handset status. We correlate it to the original SMS via the messageId we saved
// in sms_delivery_log.provider_message_id, then upgrade the row to "delivered"
// or downgrade it to "failed" and mirror the outcome onto the landlord OTP audit
// trail so agents see delivered vs failed per recipient.
//
// Configure this URL as the "Delivery Reports" callback in the Africa's Talking
// dashboard (Settings -> SMS -> Delivery Reports):
//   https://<project-ref>.supabase.co/functions/v1/sms-delivery-report
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OTP_TTL_SECONDS = 3600;
const TWILIO_GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
const TWILIO_SENDER = "WELILE";

function generateOtp(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizePhone(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  if (!d.startsWith("256") && d.length === 9) d = "256" + d;
  return "+" + d;
}

interface TwilioResult {
  ok: boolean;
  status?: string;
  reason?: string;
  messageId?: string;
  raw?: unknown;
}

// Reissue an OTP through the Twilio connector gateway. The gateway injects
// Twilio auth + the Account SID prefix, so we only POST /Messages.json.
async function sendTwilioSms(phone: string, message: string): Promise<TwilioResult> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const twilioKey = Deno.env.get("TWILIO_API_KEY");
  if (!lovableKey || !twilioKey) {
    return { ok: false, reason: "Twilio fallback not configured" };
  }
  try {
    const res = await fetch(`${TWILIO_GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": twilioKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: TWILIO_SENDER, Body: message }).toString(),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    if (!res.ok) {
      const reason = data?.error_message || data?.message || `Twilio HTTP ${res.status}: ${text.slice(0, 200)}`;
      return { ok: false, reason, raw: data ?? text };
    }
    const status = (data?.status ?? "").toString().toLowerCase();
    const accepted = ["queued", "accepted", "sending", "sent", "delivered"].includes(status);
    return {
      ok: accepted,
      status: data?.status ?? undefined,
      reason: accepted ? undefined : (data?.error_message || `Twilio status ${data?.status ?? "unknown"}`),
      messageId: data?.sid ?? undefined,
      raw: data ?? text,
    };
  } catch (e) {
    console.error("[sms-delivery-report] Twilio error:", e);
    return { ok: false, reason: e instanceof Error ? e.message : "Twilio network error" };
  }
}

// When Africa's Talking reports a failed handset delivery for a landlord OTP,
// regenerate the OTP and reissue it through Twilio so the landlord still gets a
// working code. Idempotent: skips if the challenge is no longer pending/expired
// or if a Twilio reissue already succeeded for this challenge.
async function reissueOtpViaTwilio(
  admin: ReturnType<typeof createClient>,
  challengeId: string,
): Promise<void> {
  try {
    const { data: challenge } = await admin
      .from("landlord_payout_otp_challenges")
      .select("id, agent_id, landlord_id, landlord_phone, landlord_name, amount, status, otp_expires_at")
      .eq("id", challengeId)
      .maybeSingle();
    if (!challenge) return;
    if ((challenge as any).status !== "pending") return;

    // Don't reissue twice: if a Twilio send already went out for this challenge.
    const { data: priorTwilio } = await admin
      .from("sms_delivery_log")
      .select("id")
      .eq("reference_id", challengeId)
      .eq("provider", "twilio")
      .in("status", ["sent", "delivered"])
      .limit(1)
      .maybeSingle();
    if (priorTwilio) return;

    const otp = generateOtp();
    const otp_hash = await sha256(otp);
    const otp_expires_at = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();
    await admin
      .from("landlord_payout_otp_challenges")
      .update({ otp_hash, otp_expires_at, attempts: 0 })
      .eq("id", challengeId);

    const { count: priorSends } = await admin
      .from("landlord_payout_otp_events")
      .select("id", { count: "exact", head: true })
      .eq("challenge_id", challengeId)
      .in("event_type", ["sent", "resent"]);
    const attemptNumber = (priorSends ?? 0) + 1;

    const phone = normalizePhone((challenge as any).landlord_phone);
    const result = await sendTwilioSms(
      phone,
      `Welile: You are receiving UGX ${Number((challenge as any).amount).toLocaleString()} as rent. OTP: ${otp}. Valid 1 hour. Share with the agent ONLY if you want to receive this money.`,
    );

    await admin.from("sms_delivery_log").insert({
      recipient_phone: phone,
      recipient_name: (challenge as any).landlord_name ?? null,
      message: "Landlord payout OTP (Twilio auto-fallback)",
      status: result.ok ? "sent" : "failed",
      provider: "twilio",
      provider_message_id: result.messageId ?? null,
      reference_id: challengeId,
      provider_response: result.raw ?? null,
      error: result.ok ? null : (result.reason ?? null),
      source: "issue-landlord-payout-otp",
    });

    await admin.from("landlord_payout_otp_events").insert({
      challenge_id: challengeId,
      agent_id: (challenge as any).agent_id ?? null,
      landlord_id: (challenge as any).landlord_id ?? null,
      event_type: "resent",
      landlord_phone: (challenge as any).landlord_phone,
      amount: (challenge as any).amount,
      otp_expires_at,
      detail: result.ok
        ? "OTP auto-reissued via Twilio after Africa's Talking delivery failed"
        : `OTP auto-reissue via Twilio failed: ${result.reason ?? "unknown"}`,
      failure_reason: result.ok ? null : (result.reason ?? "twilio_reissue_failed"),
      metadata: {
        attempt_number: attemptNumber,
        sms_sent: result.ok,
        sms_status: result.status ?? null,
        sms_reason: result.reason ?? null,
        sms_message_id: result.messageId ?? null,
        sms_provider: "twilio",
        fallback_used: true,
        primary_provider: "africastalking",
        primary_reason: "delivery_failed",
        delivery_status: result.ok ? "submitted" : "failed",
        trigger_source: "auto_dlr_fallback",
      },
    });
    console.log(
      `[sms-delivery-report] OTP for challenge ${challengeId} auto-reissued via Twilio (ok=${result.ok})`,
    );
  } catch (e) {
    console.error("[sms-delivery-report] Twilio reissue error:", e);
  }
}

// AT final delivery statuses. "Success" = delivered to handset. "Failed" and
// "Rejected" are terminal failures. "Sent"/"Submitted"/"Buffered" are still
// in-flight (intermediate) — we record them but keep awaiting the final report.
function mapStatus(raw: string): "delivered" | "failed" | "pending" {
  const s = (raw || "").trim().toLowerCase();
  if (s === "success" || s === "delivered") return "delivered";
  if (s === "failed" || s === "rejected") return "failed";
  return "pending";
}

async function parseBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      const j = await req.json();
      return Object.fromEntries(
        Object.entries(j ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)]),
      );
    }
    // x-www-form-urlencoded or multipart/form-data
    const form = await req.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : "";
    return out;
  } catch {
    // Fall back to raw query-string parsing of the body text.
    try {
      const text = await req.text();
      return Object.fromEntries(new URLSearchParams(text));
    } catch {
      return {};
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const params = await parseBody(req);
    // AT DLR fields: id (messageId), status, phoneNumber, networkCode,
    // failureReason, retryCount.
    const messageId = params.id || params.messageId || "";
    const rawStatus = params.status || "";
    const phoneNumber = params.phoneNumber || "";
    const failureReason = params.failureReason || "";
    const networkCode = params.networkCode || "";
    const retryCount = params.retryCount || "";

    if (!messageId) {
      console.warn("[sms-delivery-report] DLR missing message id", params);
      // Acknowledge anyway so AT does not retry indefinitely.
      return ack();
    }

    const status = mapStatus(rawStatus);
    console.log(
      `[sms-delivery-report] DLR id=${messageId} status=${rawStatus} -> ${status} phone=${phoneNumber} reason=${failureReason || "—"}`,
    );

    // Find the original SMS log row by provider message id.
    const { data: logRow } = await admin
      .from("sms_delivery_log")
      .select("id, provider_response, reference_id, source, error")
      .eq("provider_message_id", messageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const dlr = {
      type: "delivery_report",
      message_id: messageId,
      status: rawStatus,
      phone_number: phoneNumber,
      network_code: networkCode || null,
      failure_reason: failureReason || null,
      retry_count: retryCount || null,
      received_at: new Date().toISOString(),
    };

    if (logRow) {
      // Merge the DLR into the stored provider response for full auditability.
      const prev = (logRow as any).provider_response;
      const mergedResponse = prev && typeof prev === "object"
        ? { ...prev, delivery_report: dlr }
        : { send_response: prev ?? null, delivery_report: dlr };

      const update: Record<string, unknown> = {
        provider_response: mergedResponse,
      };
      // Only move to a terminal state; never overwrite a final state with a
      // later intermediate one.
      if (status === "delivered") {
        update.status = "delivered";
        update.error = null;
      } else if (status === "failed") {
        update.status = "failed";
        update.error = failureReason || (logRow as any).error || "Delivery failed";
      }

      await admin.from("sms_delivery_log").update(update).eq("id", (logRow as any).id);

      // Mirror onto the landlord OTP audit trail when this SMS was an OTP.
      const challengeId = (logRow as any).reference_id as string | null;
      const source = (logRow as any).source as string | null;
      if (challengeId && source === "issue-landlord-payout-otp" && status !== "pending") {
        const { data: challenge } = await admin
          .from("landlord_payout_otp_challenges")
          .select("agent_id, landlord_id, landlord_phone, amount")
          .eq("id", challengeId)
          .maybeSingle();

        await admin.from("landlord_payout_otp_events").insert({
          challenge_id: challengeId,
          agent_id: (challenge as any)?.agent_id ?? null,
          landlord_id: (challenge as any)?.landlord_id ?? null,
          event_type: "delivery_report",
          landlord_phone: (challenge as any)?.landlord_phone ?? phoneNumber,
          amount: (challenge as any)?.amount ?? null,
          detail: status === "delivered"
            ? "SMS delivered to landlord handset"
            : `SMS delivery failed${failureReason ? `: ${failureReason}` : ""}`,
          failure_reason: status === "failed" ? (failureReason || "delivery_failed") : null,
          metadata: {
            delivery_status: status,
            sms_status: rawStatus,
            sms_message_id: messageId,
            failure_reason: failureReason || null,
            network_code: networkCode || null,
            retry_count: retryCount || null,
          },
        });

        // Auto-reissue via Twilio when the AT delivery terminally failed.
        if (status === "failed") {
          await reissueOtpViaTwilio(admin, challengeId);
        }
      }
    } else {
      console.warn(
        `[sms-delivery-report] No sms_delivery_log row for message id ${messageId} — DLR not correlated`,
      );
    }

    return ack();
  } catch (e) {
    console.error("[sms-delivery-report] error", e);
    // Still acknowledge to avoid AT retry storms; we have the logs above.
    return ack();
  }

  function ack() {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});