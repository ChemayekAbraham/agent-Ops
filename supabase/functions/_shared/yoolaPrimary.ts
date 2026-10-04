// Shared "Yoola-first" primary send helper.
//
// Many edge functions historically shipped their own inline Africa's Talking
// (AT) sender with NO Yoola attempt, so when AT ran out of credit those flows
// silently stopped delivering. This helper lets any of those functions try
// Yoola FIRST with a single line, keeping their existing AT/other path as the
// fallback. Yoola is the primary SMS provider platform-wide.
//
// It is fully self-contained: it reads its own credentials, formats/validates
// the phone number, sends via Yoola, and writes an auditable row to
// `sms_delivery_log` using the service-role key. A logging failure never
// blocks the send. Returns true ONLY when Yoola accepted the message.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { appendSupportFooter } from "./smsFooter.ts";

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

export interface YoolaMeta {
  source?: string;
  referenceId?: string | null;
  recipientUserId?: string | null;
  recipientName?: string | null;
}

async function logYoola(
  status: "sent" | "failed",
  phone: string,
  message: string,
  meta: YoolaMeta,
  response: unknown,
  error: string | null,
  messageId: string | null,
  cost: string | null,
) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, key);
    await admin.from("sms_delivery_log").insert({
      recipient_phone: formatPhoneInternational(phone) || phone,
      recipient_user_id: meta.recipientUserId ?? null,
      recipient_name: meta.recipientName ?? null,
      message,
      status,
      provider: "yoola",
      provider_message_id: messageId,
      provider_response: response ?? null,
      cost,
      reference_id: meta.referenceId ?? null,
      source: meta.source ?? "yoola_primary",
      error,
    });
  } catch (_e) {
    // fire-and-forget: never block the send on a logging failure
  }
}

// Attempt delivery via Yoola. Returns true only if Yoola accepted the message.
// When it returns false (missing key, invalid phone, or Yoola rejection) the
// caller should fall through to its existing provider path.
export async function attemptYoolaPrimary(
  phone: string,
  message: string,
  meta: YoolaMeta = {},
): Promise<boolean> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return false; // Yoola unconfigured -> let caller fall back
  if (!isUgandanPhone(phone)) return false; // let caller's own validation log it

  // Central support footer — applied here so every Yoola-primary caller sends
  // the standardized message body without having to compose it themselves.
  message = appendSupportFooter(message);

  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: toMsisdn(phone), message, api_key: apiKey, sender: "WELILE" }),
    });
    const raw = await res.text();
    let data: any; try { data = JSON.parse(raw); } catch { data = null; }
    const status = String(data?.status ?? "").toLowerCase();
    const ok = res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    const per = data?.per_recipient?.[0] ?? null;
    const messageId = data?.message_id ? String(data.message_id) : (per?.reference ? String(per.reference) : null);
    const cost = per?.cost ?? data?.amount_charged ?? null;
    if (ok) {
      await logYoola("sent", phone, message, meta, data ?? raw?.slice(0, 300), null, messageId, cost);
      return true;
    }
    await logYoola("failed", phone, message, meta, data ?? raw?.slice(0, 300),
      `Yoola rejected (HTTP ${res.status} ${status || "no-status"})`, messageId, cost);
    return false;
  } catch (err) {
    await logYoola("failed", phone, message, meta, null,
      `Yoola network error: ${(err as Error)?.message || err}`, null, null);
    return false;
  }
}
