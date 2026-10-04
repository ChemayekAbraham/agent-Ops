// ─────────────────────────────────────────────────────────────────────────
// WhatsApp delivery via Twilio (best-effort, gated on secrets).
//
// Sends a WhatsApp message through the Twilio Messages API. It activates only
// when the Twilio WhatsApp sender is configured; otherwise it is a safe no-op
// so the calling flow (SMS/email) is never affected.
//
// Required secrets to activate:
//   TWILIO_ACCOUNT_SID      – Twilio Account SID (starts with "AC…")
//   TWILIO_AUTH_TOKEN       – Twilio auth token (or API key secret paired w/ SID)
//   TWILIO_WHATSAPP_FROM    – WhatsApp-enabled sender, e.g. "whatsapp:+14155238886"
// Optional (recommended for out-of-session / unsolicited messages, which
// WhatsApp requires to use a pre-approved template):
//   TWILIO_WHATSAPP_CONTENT_SID – approved Content template SID ("HX…")
// ─────────────────────────────────────────────────────────────────────────

/** Normalise a Ugandan (or already-international) number to E.164 (+256…). */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let p = String(phone).trim().replace(/[^\d+]/g, "");
  if (!p) return null;
  if (p.startsWith("+")) return p;
  if (p.startsWith("256")) return `+${p}`;
  if (p.startsWith("0")) return `+256${p.slice(1)}`;
  if (p.length === 9) return `+256${p}`; // bare 9-digit local number
  return `+${p}`;
}

export interface WhatsAppResult {
  ok: boolean;
  skipped?: boolean;
  error?: string | null;
  sid?: string | null;
}

/**
 * Fire a WhatsApp message. `contentVariables` is only used when a Content
 * template SID is configured (JSON map of "1","2",… → value). When no template
 * is configured, the plain `body` is sent (works within the 24h service window).
 */
export async function sendWhatsApp(
  phone: string | null | undefined,
  body: string,
  opts?: { contentVariables?: Record<string, string> },
): Promise<WhatsAppResult> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")?.trim();
  const token = Deno.env.get("TWILIO_AUTH_TOKEN")?.trim();
  const from = Deno.env.get("TWILIO_WHATSAPP_FROM")?.trim();
  const contentSid = Deno.env.get("TWILIO_WHATSAPP_CONTENT_SID")?.trim();

  if (!sid || !token || !from) {
    console.log(
      "[whatsapp] skipped — Twilio WhatsApp sender not configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM).",
    );
    return { ok: false, skipped: true, error: "not_configured" };
  }

  const to = toE164(phone);
  if (!to) {
    return { ok: false, skipped: true, error: "no_phone" };
  }

  const fromAddr = from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
  const params = new URLSearchParams();
  params.set("To", `whatsapp:${to}`);
  params.set("From", fromAddr);
  if (contentSid) {
    params.set("ContentSid", contentSid);
    if (opts?.contentVariables) {
      params.set("ContentVariables", JSON.stringify(opts.contentVariables));
    }
  } else {
    params.set("Body", body);
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
        },
        body: params.toString(),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data as any)?.message || `Twilio HTTP ${res.status}`;
      console.warn(`[whatsapp] Twilio rejected: ${err}`);
      return { ok: false, error: err, sid: null };
    }
    return { ok: true, sid: (data as any)?.sid ?? null };
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error(`[whatsapp] network error: ${msg}`);
    return { ok: false, error: msg };
  }
}
