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

// ── GSM-7 normalisation ──────────────────────────────────────────────────────
// A single character outside the GSM-7 alphabet forces the WHOLE message into
// UCS-2, which cuts the concatenated segment size from 153 characters to 67 —
// so one stray curly quote or a tick emoji in a name roughly 2.3x the number of
// segments the handset has to reassemble. Measured 2026-10-06: 4.6% of the last
// 7 days' messages carried non-ASCII, 205 of them smart punctuation that reads
// identically once transliterated.
//
// This matters because segments are exactly what goes missing. An agent sent a
// photo of a 361-character payout SMS that displayed only its first 153
// characters — precisely segment 1 of 3 — with the rest shown as placeholder
// glyphs, while our log recorded the message as "sent". Fewer segments is the
// one lever we hold that makes a full message more likely to arrive intact
// without cutting any content from it.
//
// Transliterate what has an obvious ASCII equivalent, drop what does not. Names
// are the usual source of the latter (profiles hold values like "Shafiq
// Senabulya ✅️"), and a dropped tick costs nothing; a tripled segment count
// costs the whole message.
const GSM7_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
  [/[…]/g, "..."],
  [/[     ]/g, " "],
  [/[​‌‍﻿️︎]/g, ""],
  // Bullets are used to mask account digits ("on phone •••3651"), so "*" keeps
  // that reading where "-" would not.
  [/[•·]/g, "*"],
  [/[€]/g, "EUR"],
  [/[™]/g, "TM"],
];

/** GSM-7 basic set plus the extension table, which providers encode as 2 chars. */
const GSM7_ALLOWED =
  /[^@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[~\]|]/g;

export function toGsm7(input: string): string {
  let out = input ?? "";
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) out = out.replace(pattern, replacement);
  // Anything still outside the alphabet would force UCS-2 on its own, so it goes.
  out = out.replace(GSM7_ALLOWED, "");
  // Transliteration can leave doubled spaces where a dropped glyph sat.
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").trim();
}

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
  // Then force the body into the GSM-7 alphabet, for the same reason and at the
  // same point: the logged body must be what actually went down the wire.
  message = toGsm7(message);
  // ── Phone-collection gate ────────────────────────────────────────────────
  // If the caller identifies a recipient user, require a valid profile phone
  // BEFORE reserving idempotency or contacting any provider. Blocked sends
  // are logged with a distinctive error so ops can surface them.
  let effectivePhone = phone;
  // Only consult (and potentially block on) the recipient's profile phone when
  // the caller did NOT already hand us a usable Ugandan number to send to. A
  // caller that resolved its own destination (e.g. issue-wallet-withdrawal-otp
  // sending to the payout number rather than the account phone) must not be
  // second-guessed and blocked just because that user's profiles.phone happens
  // to be a foreign number — found 2026-09-16: this silently and permanently
  // blocked every withdrawal OTP for a user with a Kenyan account phone but a
  // valid Ugandan mobile-money payout number.
  if (logCtx?.admin && logCtx.recipient_user_id && !isUgandanPhone(effectivePhone)) {
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

      // Yoola only: check the delivery report, and fail over to Africa's Talking
      // when Yoola says the message FAILED.
      //
      // This used to fail over on anything that was not "delivered", which
      // included "unconfirmed". Yoola's terminal state for these sends is
      // "sent" — accepted by the carrier, no handset receipt returned — and the
      // poller ends on "unconfirmed" for it. Measured over 7 days, Yoola
      // returned "delivered" ZERO times out of 722 confirmations, so the
      // condition was always true and the failover unconditional: every message
      // on this path went to BOTH providers and was billed twice (Yoola ~UGX 90
      // + AT ~UGX 50-75). Two identical messages from the same sender ID seconds
      // apart is also a textbook trigger for carrier anti-spam suppression,
      // which can drop both copies — the opposite of what the failover was for.
      //
      // "unconfirmed" now stays with Yoola: it accepted the message and charged
      // for it, and no handset receipt is the normal case, not evidence of
      // failure. Only an explicit failed/rejected/undelivered/expired/blocked
      // report moves the send to the next provider.
      if (ok && providerName === "yoola" && logCtx?.requireDeliveryConfirmation) {
        const messageId = extractYoolaMessageId(response);
        const confirmation = await confirmYoolaDelivery(messageId, logCtx.deliveryConfirmation ?? {});
        response = { send_response: response, delivery_confirmation: confirmation };
        if (confirmation.outcome === "failed") {
          ok = false;
          error = `Yoola reported the message failed (${confirmation.detail ?? confirmation.outcome}) — failing over to Africa's Talking`;
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
