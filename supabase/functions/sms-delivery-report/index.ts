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
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OTP_TTL_SECONDS = 3600;
// Marks the audit row of an auto-reissue so a second failure report for the
// same challenge does not reissue again. The legacy Twilio marker is kept so
// challenges reissued before Twilio was removed still count.
const AUTO_REISSUE_MARKER = "Landlord payout OTP (auto-reissue after AT failure)";
const LEGACY_TWILIO_MARKER = "Landlord payout OTP (Twilio auto-fallback)";

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

interface ReissueResult {
  ok: boolean;
  provider: string | null;
  status?: string;
  reason?: string;
  messageId?: string;
  raw?: unknown;
}

async function sendViaYoola(phone: string, message: string): Promise<ReissueResult | null> {
  const apiKey = (Deno.env.get("YOOLA_SMS_API_KEY") || "").trim();
  if (!apiKey) return null;
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: phone.replace(/\D/g, ""), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    const status = String(data?.status ?? "").toLowerCase();
    const accepted = res.ok && ["success", "ok", "sent", "queued"].includes(status);
    return {
      ok: accepted,
      provider: "yoola",
      status: data?.status ?? undefined,
      reason: accepted ? undefined : (data?.message || `Yoola HTTP ${res.status}`),
      messageId: data?.message_id ?? undefined,
      raw: data ?? text,
    };
  } catch (e) {
    return { ok: false, provider: "yoola", reason: e instanceof Error ? e.message : "Yoola network error" };
  }
}

async function sendViaLana(phone: string, message: string): Promise<ReissueResult | null> {
  const apiKey = (Deno.env.get("LANA_SMS_API_KEY") || "").trim();
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ phone: phone.replace(/\D/g, ""), sender_id: "WELILE", message }).toString(),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    const accepted = res.ok && (data?.status === true || String(data?.status ?? "").toLowerCase() === "success");
    return {
      ok: accepted,
      provider: "lana",
      status: data?.status !== undefined ? String(data.status) : undefined,
      reason: accepted ? undefined : (data?.message || `LANA HTTP ${res.status}`),
      messageId: data?.message_id ?? data?.id ?? undefined,
      raw: data ?? text,
    };
  } catch (e) {
    return { ok: false, provider: "lana", reason: e instanceof Error ? e.message : "LANA network error" };
  }
}

// Africa's Talking just failed this message, so the reissue goes to the other
// two providers in the normal order: Yoola, then LANA.
async function sendReissueSms(phone: string, message: string): Promise<ReissueResult> {
  const reasons: string[] = [];
  for (const send of [sendViaYoola, sendViaLana]) {
    const r = await send(phone, message);
    if (r === null) continue;
    if (r.ok) return r;
    reasons.push(`${r.provider}: ${r.reason ?? "rejected"}`);
  }
  return { ok: false, provider: null, reason: reasons.join(" | ") || "No backup SMS provider configured" };
}

// When Africa's Talking reports a failed handset delivery for a landlord OTP,
// regenerate the OTP and reissue it through Yoola (then LANA) so the landlord
// still gets a working code. Idempotent: skips if the challenge is no longer
// pending or if an auto-reissue already succeeded for this challenge.
async function reissueOtpViaBackup(
  // deno-lint-ignore no-explicit-any
  admin: any,
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

    // Don't reissue twice: if an auto-reissue already went out for this challenge.
    const { data: priorReissue } = await admin
      .from("sms_delivery_log")
      .select("id")
      .eq("reference_id", challengeId)
      .in("message", [AUTO_REISSUE_MARKER, LEGACY_TWILIO_MARKER])
      .in("status", ["sent", "delivered"])
      .limit(1)
      .maybeSingle();
    if (priorReissue) return;

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
    const result = await sendReissueSms(
      phone,
      `Welile: You are receiving UGX ${Number((challenge as any).amount).toLocaleString()} as rent. OTP: ${otp}. Valid 1 hour. Share with the agent ONLY if you want to receive this money.`,
    );

    await admin.from("sms_delivery_log").insert({
      recipient_phone: phone,
      recipient_name: (challenge as any).landlord_name ?? null,
      message: AUTO_REISSUE_MARKER,
      status: result.ok ? "sent" : "failed",
      provider: result.provider ?? "none",
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
        ? `OTP auto-reissued via ${result.provider} after Africa's Talking delivery failed`
        : `OTP auto-reissue failed: ${result.reason ?? "unknown"}`,
      failure_reason: result.ok ? null : (result.reason ?? "backup_reissue_failed"),
      metadata: {
        attempt_number: attemptNumber,
        sms_sent: result.ok,
        sms_status: result.status ?? null,
        sms_reason: result.reason ?? null,
        sms_message_id: result.messageId ?? null,
        sms_provider: result.provider,
        fallback_used: true,
        primary_provider: "africastalking",
        primary_reason: "delivery_failed",
        delivery_status: result.ok ? "submitted" : "failed",
        trigger_source: "auto_dlr_fallback",
      },
    });
    console.log(
      `[sms-delivery-report] OTP for challenge ${challengeId} auto-reissued via ${result.provider ?? "none"} (ok=${result.ok})`,
    );
  } catch (e) {
    console.error("[sms-delivery-report] backup reissue error:", e);
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

        // Auto-reissue via Yoola/LANA when the AT delivery terminally failed.
        if (status === "failed") {
          await reissueOtpViaBackup(admin, challengeId);
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