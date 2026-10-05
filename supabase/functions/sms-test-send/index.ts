import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  let cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("0")) cleaned = "256" + cleaned.substring(1);
  else if (cleaned.startsWith("256")) {
    /* keep */
  } else if (cleaned.length === 9) cleaned = "256" + cleaned;
  return "+" + cleaned;
}

async function sendSMS(phone: string, message: string) {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    return { ok: false, reason: "Missing Africa's Talking credentials", provider: "africastalking" };
  }

  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const formattedPhone = formatPhoneInternational(phone);
  const body = new URLSearchParams({
    username,
    to: formattedPhone,
    message,
    // WELILE is a registered alphanumeric sender on Africa's Talking
    // (unlike Yoola, which rejects it). Force it here for the test path.
    from: "WELILE",
  });

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const rawText = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    /* keep raw */
  }

  const recipients = parsed?.SMSMessageData?.Recipients || [];
  const success = recipients.some(
    (r: any) => r.statusCode === 101 || r.statusCode === 100,
  );

  return {
    ok: success,
    httpStatus: res.status,
    formattedPhone,
    sandbox: isSandbox,
    recipients,
    raw: parsed ?? rawText,
    provider: "africastalking",
    reason: success ? undefined : (parsed?.SMSMessageData?.Message || recipients?.[0]?.status || `AT HTTP ${res.status}`),
  };
}

// Twilio fallback — routed through the Lovable connector gateway (same path as
// the production landlord-payout OTP function), so we only POST /Messages.json.
const TWILIO_GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
const TWILIO_SENDER = "WELILE";

// Yoola — the PRIMARY production SMS provider. Posts JSON to /api/v1/send.
// WELILE is the registered sender ID and must be set explicitly on every call.
function toYoolaDigits(phone: string): string {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  else if (d.length === 9) d = "256" + d;
  return d;
}
async function sendYoolaSMS(phone: string, message: string, opts: { sender?: string | null } = {}) {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return { ok: false, reason: "Yoola not configured", provider: "yoola" };
  const bareDigits = toYoolaDigits(phone);
  // Default to WELILE. An explicit opts.sender can still override for testing.
  const useSender = opts.sender === undefined ? null : (opts.sender || null);
  const payload: Record<string, unknown> = { phone: bareDigits, message, api_key: apiKey, sender: "WELILE" };
  if (useSender) payload.sender = useSender;
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const rawText = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(rawText); } catch { /* keep raw */ }
    const status = String(parsed?.status ?? "").toLowerCase();
    const accepted =
      res.ok &&
      (["success", "ok", "sent", "queued"].includes(status) ||
        (status === "" && !parsed?.error));
    return {
      ok: accepted,
      httpStatus: res.status,
      formattedPhone: bareDigits,
      sender: useSender ?? "(none)",
      status: parsed?.status ?? null,
      reason: accepted ? undefined : (parsed?.error || parsed?.message || `Yoola status ${parsed?.status ?? res.status}`),
      raw: parsed ?? rawText,
      provider: "yoola",
    };
  } catch (e) {
    return { ok: false, formattedPhone: bareDigits, reason: e instanceof Error ? e.message : "Yoola network error", provider: "yoola" };
  }
}
async function sendTwilioSMS(phone: string, message: string) {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const twilioKey = Deno.env.get("TWILIO_API_KEY");
  if (!lovableKey || !twilioKey) {
    return { ok: false, reason: "Twilio fallback not configured", provider: "twilio" };
  }
  const formattedPhone = formatPhoneInternational(phone);
  try {
    const res = await fetch(`${TWILIO_GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": twilioKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: formattedPhone, From: TWILIO_SENDER, Body: message }).toString(),
    });
    const rawText = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(rawText); } catch { /* keep raw */ }
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        formattedPhone,
        reason: parsed?.error_message || parsed?.message || `Twilio HTTP ${res.status}`,
        raw: parsed ?? rawText,
        provider: "twilio",
      };
    }
    const status = (parsed?.status ?? "").toString().toLowerCase();
    const accepted = ["queued", "accepted", "sending", "sent", "delivered"].includes(status);
    return {
      ok: accepted,
      httpStatus: res.status,
      formattedPhone,
      status: parsed?.status ?? null,
      messageId: parsed?.sid ?? null,
      reason: accepted ? undefined : (parsed?.error_message || `Twilio status ${parsed?.status ?? "unknown"}`),
      raw: parsed ?? rawText,
      provider: "twilio",
    };
  } catch (e) {
    return { ok: false, formattedPhone, reason: e instanceof Error ? e.message : "Twilio network error", provider: "twilio" };
  }
}

// Africa's Talking first, then automatic Twilio fallback — identical strategy to
// the production landlord payout OTP path, so this is a true end-to-end check.
async function sendWithFallback(phone: string, message: string) {
  const primary = await sendSMS(phone, message);
  if (primary.ok) return { ...primary, fallbackUsed: false };
  const fallback = await sendTwilioSMS(phone, message);
  return {
    ...fallback,
    fallbackUsed: true,
    primaryProvider: "africastalking",
    primaryReason: (primary as any).reason ?? "AT send not accepted",
    primaryRaw: (primary as any).raw ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    let phone = "0777607640";
    let message =
      "[Welile Test] Background SMS API test successful. If you received this, the SMS pipeline is healthy. — Welile Ops";
    let provider = "auto"; // 'auto' = AT then Twilio fallback | 'twilio' = force Twilio | 'africastalking' = force AT
    let no_sender = false; // legacy flag; ignored because WELILE is always sent
    let sender: string | undefined = undefined; // when set (+ provider=yoola), override the default WELILE sender id

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body?.phone) phone = String(body.phone);
      if (body?.message) message = String(body.message);
      if (body?.provider) provider = String(body.provider);
      if (typeof body?.no_sender === "boolean") no_sender = body.no_sender;
      if (typeof body?.sender === "string" && body.sender.trim()) sender = body.sender.trim();
    }

    const startedAt = new Date().toISOString();
    const result =
      provider === "yoola"
        ? { ...(await sendYoolaSMS(phone, message, sender !== undefined ? { sender } : (no_sender ? { sender: null } : {}))), fallbackUsed: false, forced: "yoola" }
        : provider === "twilio"
        ? { ...(await sendTwilioSMS(phone, message)), fallbackUsed: false, forced: "twilio" }
        : provider === "africastalking"
        ? { ...(await sendSMS(phone, message)), fallbackUsed: false, forced: "africastalking" }
        : await sendWithFallback(phone, message);
    const finishedAt = new Date().toISOString();

    // Audit log so we have a trail
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const admin = createClient(supabaseUrl, serviceKey);
      await admin.from("audit_logs").insert({
        action_type: "sms_api_diagnostic_test",
        table_name: "sms_test",
        metadata: {
          phone,
          message,
          started_at: startedAt,
          finished_at: finishedAt,
          ...result,
        },
      });
    } catch (logErr) {
      console.warn("[sms-test-send] audit log failed:", logErr);
    }

    return new Response(
      JSON.stringify({ phone, message, startedAt, finishedAt, ...result }),
      {
        status: result.ok ? 200 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[sms-test-send] Error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});