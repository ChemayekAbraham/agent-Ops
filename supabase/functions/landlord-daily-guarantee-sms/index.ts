import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const ALLOWED_ROLES = ["coo", "ceo", "cto", "cmo", "super_admin", "manager"];

// Daily marketing message to every landlord.
const MESSAGE =
  `Your house shouldn't stay empty. Your rent shouldn't be delayed. WELILE connects you to verified tenants and guarantees your monthly rent. List your property now: welileapp.com/wjoin WhatsApp: +256 748 747134`;

const SMS_ATTEMPT_TIMEOUT_MS = 5000;
const SMS_MAX_ATTEMPTS = 2;
const SMS_BACKOFF_BASE_MS = 300;
const SEND_CONCURRENCY = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SmsResult {
  accepted: boolean;
  provider?: string;
  reason?: string;
}

const KNOWN_COUNTRY_CODES = [
  "256", "254", "255", "250", "257", "211", "243", "234", "27", "44", "1",
  "91", "86", "33", "49", "81", "82", "61", "55", "7", "966", "971", "20",
  "212", "233", "225", "221", "260", "263", "267", "251",
];

function formatPhoneInternational(rawPhone: string): string {
  let digits = (rawPhone || "").replace(/\D/g, "");
  for (const code of KNOWN_COUNTRY_CODES) {
    if (digits.startsWith(code) && digits.length > code.length + 5) {
      return "+" + digits;
    }
  }
  if (digits.startsWith("0")) digits = "256" + digits.slice(1);
  return "+" + digits;
}

const toBareDigits = (p: string) => formatPhoneInternational(p).replace(/^\+/, "");

function isValidPhone(p: string | null | undefined): boolean {
  if (!p) return false;
  const t = String(p).trim();
  if (!t || t === "-") return false;
  return t.replace(/\D/g, "").length >= 9;
}

const RETRYABLE = new Set(["timeout", "network_error"]);

async function sendYoolaAttempt(apiKey: string, phone: string, message: string): Promise<SmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: toBareDigits(phone), message, api_key: apiKey, sender: "WELILE" }),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const status = String(data?.status ?? "").toLowerCase();
    if (res.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued")) {
      return { accepted: true, provider: "yoola" };
    }
    if (res.ok && !data?.error && status === "") return { accepted: true, provider: "yoola" };
    if (!res.ok && (res.status >= 500 || res.status === 429)) return { accepted: false, reason: "network_error" };
    return { accepted: false, reason: `yoola_${res.status}_${status || "rejected"}` };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return { accepted: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaYoola(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return { accepted: false, reason: "yoola_not_configured" };
  let last: SmsResult = { accepted: false, reason: "network_error" };
  for (let attempt = 1; attempt <= SMS_MAX_ATTEMPTS; attempt++) {
    last = await sendYoolaAttempt(apiKey, phone, message);
    if (last.accepted || !RETRYABLE.has(last.reason ?? "")) return last;
    if (attempt < SMS_MAX_ATTEMPTS) await sleep(SMS_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }
  return last;
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return { accepted: false, reason: "missing_credentials" };
  const isSandbox = username.toLowerCase() === "sandbox";
  const url = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const params = new URLSearchParams({
    username, from: "WELILE",
    to: formatPhoneInternational(phone),    message,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    const recipients = data?.SMSMessageData?.Recipients;
    if (recipients && recipients.length > 0) {
      const s = recipients[0].statusCode;
      if (s === 101 || s === 100 || s === 102) return { accepted: true, provider: "africastalking" };
      return { accepted: false, reason: `at_status_${s}` };
    }
    return { accepted: false, reason: "at_no_recipients" };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return { accepted: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaLana(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return { accepted: false, reason: "lana_not_configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: toBareDigits(phone), sender_id: "WELILE", message}),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const raw = data?.status;
    const s = String(raw ?? "").toLowerCase();
    if (res.ok && (raw === true || s === "success" || s === "true" || s === "ok" || s === "sent" || s === "queued")) {
      return { accepted: true, provider: "lana" };
    }
    return { accepted: false, reason: `lana_${res.status}_rejected` };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return { accepted: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

// Provider chain: Yoola (primary) -> Africa's Talking -> LANA.
async function sendSMS(phone: string, message: string): Promise<SmsResult> {
  const yoola = await sendViaYoola(phone, message);
  if (yoola.accepted) return yoola;
  const at = await sendViaAfricasTalking(phone, message);
  if (at.accepted) return at;
  const lana = await sendViaLana(phone, message);
  if (lana.accepted) return lana;
  if (yoola.reason && yoola.reason !== "yoola_not_configured") return yoola;
  if (at.reason && at.reason !== "missing_credentials") return at;
  return lana;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const testPhoneRaw = (body.test_phone || "").toString().trim();
    const isTest = !!testPhoneRaw;

    // A test send (manual) requires an authorized staff user. The daily batch
    // run is triggered by cron and needs no user.
    if (isTest) {
      const authHeader = req.headers.get("Authorization");
      const token = authHeader?.replace(/^Bearer\s+/i, "") ?? "";
      const { data: userData } = await admin.auth.getUser(token);
      const caller = userData?.user;
      if (!caller) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", caller.id);
      const allowed = (roles || []).some((r: any) => ALLOWED_ROLES.includes(r.role));
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await sendSMS(testPhoneRaw, MESSAGE);
      await admin.from("sms_delivery_log").insert({
        recipient_phone: formatPhoneInternational(testPhoneRaw),
        message: MESSAGE,
        status: result.accepted ? "sent" : "failed",
        provider: result.provider ?? "none",
        source: "landlord-daily-guarantee-test",
        error: result.accepted ? null : result.reason ?? null,
      });
      return new Response(JSON.stringify({ success: true, test: true, ...result }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- Daily batch run: every distinct landlord phone ----
    const PAGE = 1000;
    // Pull the opt-out list once so we never message landlords who tapped "Stop".
    const optedOut = new Set<string>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from("sms_opt_outs")
        .select("phone")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const row of data) optedOut.add(formatPhoneInternational((row as any).phone));
      if (data.length < PAGE) break;
    }

    // Pull CTO-managed exceptions for this message type ('all' or 'daily_guarantee').
    {
      const { data: exData } = await admin
        .from("sms_message_exceptions")
        .select("phone")
        .in("message_type", ["all", "daily_guarantee"]);
      for (const row of exData ?? []) optedOut.add(formatPhoneInternational((row as any).phone));
    }

    const seen = new Set<string>();
    const recipients: { phone: string; name: string | null }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from("landlords")
        .select("phone, name")
        .not("phone", "is", null)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const row of data) {
        const phone = (row as any).phone as string;
        if (!isValidPhone(phone)) continue;
        const intl = formatPhoneInternational(phone);
        if (seen.has(intl)) continue;
        if (optedOut.has(intl)) continue;
        seen.add(intl);
        recipients.push({ phone: intl, name: (row as any).name ?? null });
      }
      if (data.length < PAGE) break;
    }

    let sent = 0, failed = 0;
    const byProvider: Record<string, number> = {};
    const logRows: any[] = [];

    for (let i = 0; i < recipients.length; i += SEND_CONCURRENCY) {
      const batch = recipients.slice(i, i + SEND_CONCURRENCY);
      const results = await Promise.all(batch.map((r) => sendSMS(r.phone, MESSAGE)));
      results.forEach((res, idx) => {
        const r = batch[idx];
        if (res.accepted) {
          sent++;
          byProvider[res.provider ?? "unknown"] = (byProvider[res.provider ?? "unknown"] ?? 0) + 1;
        } else {
          failed++;
        }
        logRows.push({
          recipient_phone: r.phone,
          recipient_name: r.name,
          message: MESSAGE,
          status: res.accepted ? "sent" : "failed",
          provider: res.provider ?? "none",
          source: "landlord-daily-guarantee",
          error: res.accepted ? null : res.reason ?? null,
        });
      });
    }

    for (let i = 0; i < logRows.length; i += 500) {
      await admin.from("sms_delivery_log").insert(logRows.slice(i, i + 500));
    }

    await admin.from("audit_logs").insert({
      action_type: "landlord_daily_guarantee_sms",
      table_name: "landlords",
      record_id: "00000000-0000-0000-0000-000000000000",
      reason: "Daily guaranteed-rent marketing SMS to every landlord phone",
      metadata: { total: recipients.length, sent, failed, by_provider: byProvider, opted_out: optedOut.size },
    });

    return new Response(JSON.stringify({
      success: true, total: recipients.length, sent, failed, by_provider: byProvider, opted_out: optedOut.size,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("landlord-daily-guarantee-sms error:", e);
    return new Response(JSON.stringify({ error: e?.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
