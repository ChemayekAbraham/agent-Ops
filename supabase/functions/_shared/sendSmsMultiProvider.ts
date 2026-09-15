// Shared multi-provider SMS sender: Yoola (primary) -> Africa's Talking -> Lana.
// Mirrors the provider chain used by approve-withdrawal so any flow can send an
// auditable, idempotent SMS without duplicating provider code.
import {
  logSmsDelivery,
  reserveSmsIdempotency,
  finalizeSmsDelivery,
  type SmsAttemptRecord,
} from "./smsDeliveryLog.ts";
import { appendSupportFooter } from "./smsFooter.ts";
import { confirmYoolaDelivery, extractYoolaMessageId } from "./yoolaDeliveryConfirm.ts";

export function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return digits ? `+${digits}` : "";
}
export function isUgandanPhone(phone: string): boolean {
  const f = formatPhoneInternational(phone);
  return f.startsWith("+256") && f.length >= 13;
}
function toMsisdn(phone: string): string {
  return formatPhoneInternational(phone).replace(/^\+/, "");
}

async function sendViaYoola(phone: string, message: string) {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // "WELILE" is the registered Yoola sender ID (Yoola echoes
      // sender_used:"WELILE" on accepted sends) and must be set explicitly.
      body: JSON.stringify({ phone: toMsisdn(phone), message, api_key: apiKey, sender: "WELILE" }),
    });
    const raw = await res.text();
    let data: any; try { data = JSON.parse(raw); } catch { data = null; }
    const status = String(data?.status ?? "").toLowerCase();
    const ok = res.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued" || (!data?.error && status === ""));
    return { ok, error: ok ? null : `Yoola rejected (HTTP ${res.status} ${status || "no-status"})`, response: data ?? raw?.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: `Yoola network error: ${(err as Error)?.message || err}`, response: null };
  }
}
async function sendViaAT(phone: string, message: string) {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return null;
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    // WELILE is the registered alphanumeric sender on this Africa's Talking
    // account and must be set explicitly on every SMS call site.
    const body = new URLSearchParams({ username, from: "WELILE", to: formatPhoneInternational(phone), message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `AT HTTP ${res.status}`, response: text?.slice(0, 300) || null };
    }
    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    const accepted = recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
    const reason = recipients.map((r: any) => `${r.number}:${r.status}`).join(", ");
    return { ok: accepted, error: accepted ? null : (reason ? `AT rejected (${reason})` : "AT no accepted recipients"), response: data };
  } catch (err) {
    return { ok: false, error: `AT network error: ${(err as Error)?.message || err}`, response: null };
  }
}
async function sendViaLana(phone: string, message: string) {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ phone: toMsisdn(phone), sender_id: "WELILE", message}),
    });
    const raw = await res.text();
    let data: any; try { data = JSON.parse(raw); } catch { data = null; }
    const ok = res.ok && data?.status === true;
    return { ok, error: ok ? null : `LANA rejected (${data?.message || `HTTP ${res.status}`})`, response: data ?? raw?.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: `LANA network error: ${(err as Error)?.message || err}`, response: null };
  }
}

export interface SmsLogCtx {
  admin: any;
  source: string;
  reference_id?: string | null;
  recipient_user_id?: string | null;
  recipient_name?: string | null;
  idempotencyKey?: string | null;
  /**
   * Time-critical SMS (cash-deposit codes): require Yoola to CONFIRM handset
   * delivery before we call the send done. Yoola accepting the request is not
   * delivery — when it does not confirm inside the window we fail over to
   * Africa's Talking instead of leaving the depositor without a code.
   */
  requireDeliveryConfirmation?: boolean;
  /** Tighten/loosen the Yoola delivery-report polling window. */
  deliveryConfirmation?: { attempts?: number; delayMs?: number };
}

/**
 * Phone-collection gate: any outbound SMS whose recipient is a known user
 * (recipient_user_id supplied) is blocked until that user has a valid Ugandan
 * `profiles.phone`. Prevents wasted provider spend and silent "why didn't I
 * get an SMS?" reports for users who signed up with email only and have not
 * yet completed the PhoneCollectionGate popup.
 *
 * Returns the profile phone when present so the caller can also use it as a
 * fallback if `phone` was empty, or `{ blocked: true }` when the gate rejects.
 */
async function resolveProfilePhoneGate(
  admin: any,
  recipient_user_id: string,
): Promise<{ blocked: boolean; profilePhone: string | null }> {
  try {
    const { data } = await admin
      .from("profiles")
      .select("phone")
      .eq("id", recipient_user_id)
      .maybeSingle();
    const p = String(data?.phone ?? "").trim();
    if (!p || !isUgandanPhone(p)) return { blocked: true, profilePhone: null };
    return { blocked: false, profilePhone: p };
  } catch {
    // Fail-open on DB hiccup — do not silently drop SMS due to a lookup error.
    return { blocked: false, profilePhone: null };
  }
}

// Returns true when delivered (or an identical SMS was already delivered before).
export async function sendSMS(phone: string, message: string, logCtx?: SmsLogCtx): Promise<boolean> {
  // Central support footer — applied once, before idempotency reservation, so
  // the reserved/logged body matches what providers actually transmit.
  message = appendSupportFooter(message);
  // ── Phone-collection gate ────────────────────────────────────────────────
  // If the caller identifies a recipient user, require a valid profile phone
  // BEFORE reserving idempotency or contacting any provider. Blocked sends
  // are logged with a distinctive error so ops can surface them.
  let effectivePhone = phone;
  if (logCtx?.admin && logCtx.recipient_user_id) {
    const gate = await resolveProfilePhoneGate(logCtx.admin, logCtx.recipient_user_id);
    if (gate.blocked) {
      const reason = "Blocked: recipient has no phone on profile (PhoneCollectionGate pending)";
      try {
        await logSmsDelivery(logCtx.admin, {
          recipient_phone: phone || "unknown",
          recipient_user_id: logCtx.recipient_user_id,
          recipient_name: logCtx.recipient_name ?? null,
          message,
          status: "failed",
          provider: "gate",
          attempts: [{ provider: "gate", ok: false, error: reason, attempt: 1 }],
          retries: 0,
          reference_id: logCtx.reference_id ?? null,
          source: logCtx.source,
          error: reason,
        });
      } catch { /* auditing must never throw */ }
      return false;
    }
    // Prefer the profile phone when the caller passed nothing usable.
    if (!isUgandanPhone(effectivePhone) && gate.profilePhone) {
      effectivePhone = gate.profilePhone;
    }
  }

  let reservedLogId: string | null = null;
  if (logCtx?.admin && logCtx.idempotencyKey) {
    const reservation = await reserveSmsIdempotency(logCtx.admin, {
      idempotency_key: logCtx.idempotencyKey,
      recipient_phone: effectivePhone || "unknown",
      recipient_user_id: logCtx.recipient_user_id ?? null,
      recipient_name: logCtx.recipient_name ?? null,
      message,
      reference_id: logCtx.reference_id ?? null,
      source: logCtx.source,
    });
    if (!reservation.proceed) return reservation.alreadySent;
    reservedLogId = reservation.logId;
  }

  const providerNames: Record<string, string> = { sendViaYoola: "yoola", sendViaAT: "africastalking", sendViaLana: "lana" };
  const trail: SmsAttemptRecord[] = [];
  let delivered = false;
  let invalid = false;

  if (!isUgandanPhone(effectivePhone)) {
    invalid = true;
  } else {
    for (const send of [sendViaYoola, sendViaAT, sendViaLana]) {
      const r = await send(effectivePhone, message);
      if (r === null) continue;
      const providerName = providerNames[send.name] || send.name;
      let ok = r.ok;
      let error = r.error;
      let response: any = (r as any).response;

      // Yoola only: hold the send open until the delivery report confirms the
      // handset received it, then fall through to Africa's Talking if it does not.
      if (ok && providerName === "yoola" && logCtx?.requireDeliveryConfirmation) {
        const messageId = extractYoolaMessageId(response);
        const confirmation = await confirmYoolaDelivery(messageId, logCtx.deliveryConfirmation ?? {});
        response = { send_response: response, delivery_confirmation: confirmation };
        if (confirmation.outcome !== "delivered") {
          ok = false;
          error = `Yoola accepted but did not confirm delivery (${confirmation.detail ?? confirmation.outcome}) — failing over to Africa's Talking`;
        }
      }

      trail.push({ provider: providerName, ok, error, response, attempt: 1 });
      if (ok) { delivered = true; break; }
    }
  }

  const errorText = delivered
    ? null
    : invalid
      ? "Invalid Ugandan phone/MoMo number"
      : (trail.filter((t) => !t.ok && t.error).map((t) => `${t.provider}: ${t.error}`).join(" | ") || "No SMS provider configured");

  if (reservedLogId) {
    await finalizeSmsDelivery(logCtx!.admin, reservedLogId, { status: delivered ? "sent" : "failed", attempts: trail, retries: 0, error: errorText });
  } else if (logCtx?.admin) {
    await logSmsDelivery(logCtx.admin, {
      recipient_phone: effectivePhone || "unknown",
      recipient_user_id: logCtx.recipient_user_id ?? null,
      recipient_name: logCtx.recipient_name ?? null,
      message,
      status: delivered ? "sent" : "failed",
      attempts: trail,
      retries: 0,
      reference_id: logCtx.reference_id ?? null,
      source: logCtx.source,
      error: errorText,
    });
  }

  return delivered;
}
