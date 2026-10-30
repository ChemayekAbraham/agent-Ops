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
// LANA — the last production fallback. Form body with a Bearer key;
// { status: true } or { status: "success" } = accepted.
async function sendLanaSMS(phone: string, message: string) {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return { ok: false, reason: "LANA not configured", provider: "lana" };
  const bareDigits = toYoolaDigits(phone);
  try {
    const res = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ phone: bareDigits, sender_id: "WELILE", message }).toString(),
    });
    const rawText = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(rawText); } catch { /* keep raw */ }
    const accepted = res.ok && (parsed?.status === true || String(parsed?.status ?? "").toLowerCase() === "success");
    return {
      ok: accepted,
      httpStatus: res.status,
      formattedPhone: bareDigits,
      status: parsed?.status ?? null,
      reason: accepted ? undefined : (parsed?.message || `LANA HTTP ${res.status}`),
      raw: parsed ?? rawText,
      provider: "lana",
    };
  } catch (e) {
    return { ok: false, formattedPhone: bareDigits, reason: e instanceof Error ? e.message : "LANA network error", provider: "lana" };
  }
}

// Yoola, then Africa's Talking, then LANA — the same order as production
// (_shared/sendSmsMultiProvider.ts), so this is a true end-to-end check.
async function sendWithFallback(phone: string, message: string) {
  const tried: Array<{ provider: string; reason?: string }> = [];
  let last: any = null;
  for (const send of [
    () => sendYoolaSMS(phone, message),
    () => sendSMS(phone, message),
    () => sendLanaSMS(phone, message),
  ]) {
    last = await send();
    if (last.ok) break;
    tried.push({ provider: last.provider, reason: last.reason });
  }
  return {
    ...last,
    fallbackUsed: tried.length > 0,
    primaryProvider: "yoola",
    primaryReason: tried[0]?.reason ?? null,
    failedProviders: tried,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    let phone = "0777607640";
    let message =
      "[Welile Test] Background SMS API test successful. If you received this, the SMS pipeline is healthy. — Welile Ops";
    let provider = "auto"; // 'auto' = Yoola -> AT -> LANA | 'yoola' / 'africastalking' / 'lana' = force one
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
        : provider === "lana"
        ? { ...(await sendLanaSMS(phone, message)), fallbackUsed: false, forced: "lana" }
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