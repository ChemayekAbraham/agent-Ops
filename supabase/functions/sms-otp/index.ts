import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Durable, database-backed rate limiting for OTP sends.
// These limits persist across page reloads and edge function cold starts,
// so they cannot be bypassed by reloading the OTP screen.
const MAX_SENDS_PER_HOUR = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
// Cross-phone caps enforced per user (auth) and per IP so an attacker cannot
// bypass the per-phone caps by rotating the phone number in the request body.
const MAX_SENDS_PER_USER_HOUR = 5;
const MAX_SENDS_PER_USER_DAY = 10;
const MAX_SENDS_PER_IP_HOUR = 10;
const MAX_SENDS_PER_IP_DAY = 30;

function clientIpFrom(req: Request): string | null {
  const raw = req.headers.get("x-forwarded-for") ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "";
  const first = raw.split(",")[0]?.trim();
  return first || null;
}

async function userIdFromAuth(
  admin: any,
  req: Request,
): Promise<string | null> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const { data } = await admin.auth.getUser(token);
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

function generateOTP(): string {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < 6; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
}

// Known country code prefixes (longest first for greedy matching)
const KNOWN_COUNTRY_CODES = [
  '256', '254', '255', '250', '257', '211', '243', '234', '27', '44', '1',
  // Additional global codes
  '91', '86', '33', '49', '81', '82', '61', '55', '7', '966', '971', '20',
  '212', '233', '225', '221', '260', '263', '267', '251',
];

function formatPhoneInternational(rawPhone: string): string {
  let digits = rawPhone.replace(/\D/g, "");

  // Uganda local numbers must be normalized before the generic country-code
  // matcher. A bare 9-digit number like 704825473 is Uganda (+256), not +7.
  if (digits.startsWith("0")) {
    digits = "256" + digits.slice(1);
    return "+" + digits;
  }
  if (digits.length === 9) {
    return "+256" + digits;
  }

  // If already has a known country code prefix, just add +
  for (const code of KNOWN_COUNTRY_CODES) {
    if (digits.startsWith(code) && digits.length > code.length + 5) {
      return "+" + digits;
    }
  }

  return "+" + digits;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function extractProviderFields(data: Record<string, unknown>): { messageId: string | null; cost: string | null } {
  const response = data as any;
  const recipient = Array.isArray(response?.per_recipient)
    ? response.per_recipient[0]
    : Array.isArray(response?.SMSMessageData?.Recipients)
      ? response.SMSMessageData.Recipients[0]
      : null;

  return {
    messageId: firstString(
      response?.message_id,
      response?.messageId,
      response?.id,
      recipient?.message_id,
      recipient?.messageId,
      recipient?.reference,
    ),
    cost: firstString(
      recipient?.cost,
      response?.amount_charged,
      response?.credits_used,
      recipient?.credits,
    ),
  };
}

interface SmsResult {
  /** True when the gateway accepted the message for delivery (statusCode 101/100). */
  accepted: boolean;
  /** Short reason when not accepted, for logging/debugging. */
  reason?: string;
  /** Provider's raw response, retained for delivery-report lookups and audits. */
  response?: unknown;
  /** Provider message id/reference when supplied. */
  messageId?: string | null;
  /** Provider-reported send cost when supplied. */
  cost?: string | null;
}

/** A single provider attempt within one logical SMS send. */
interface ProviderAttempt {
  provider: string;
  accepted: boolean;
  reason?: string;
  response?: unknown;
  messageId?: string | null;
  cost?: string | null;
  /** ISO timestamp when this provider attempt started. */
  started_at: string;
  /** ISO timestamp when this provider attempt finished. */
  finished_at: string;
  /** Whether the provider was configured/eligible to attempt at all. */
  attempted: boolean;
}

/** Final outcome of a logical SMS send, including the full provider trail. */
interface SmsOutcome extends SmsResult {
  /** Provider that ultimately accepted the message (undefined if none did). */
  provider?: string;
  /** Ordered list of every provider attempt for this send. */
  attempts: ProviderAttempt[];
}

/** A reason that means the provider was skipped (never actually dialed out). */
function wasSkipped(reason?: string): boolean {
  return reason === "missing_credentials" ||
    (typeof reason === "string" && reason.endsWith("not_configured"));
}

// Per-attempt network timeout for the gateway call. Keeps a single stuck
// request from hanging the whole send. Each retry gets its own fresh timeout.
const SMS_ATTEMPT_TIMEOUT_MS = 5000;
// Number of attempts (1 initial + retries) when the gateway times out or errors.
const SMS_MAX_ATTEMPTS = 3;
// Base backoff between retries; grows exponentially (300ms, 600ms, 1200ms...).
const SMS_BACKOFF_BASE_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Format a phone number for Yoola SMS: digits only, with the country code but
 * WITHOUT a leading "+" (e.g. "256704487563"). Defaults bare local numbers to
 * Uganda (+256).
 */
function formatPhoneYoola(rawPhone: string): string {
  return formatPhoneInternational(rawPhone).replace(/^\+/, "");
}

/**
 * Format a phone number for LANA SMS: digits only, with the country code but
 * WITHOUT a leading "+" (e.g. "256704487563"). Same shape as Yoola.
 */
function formatPhoneLana(rawPhone: string): string {
  return formatPhoneInternational(rawPhone).replace(/^\+/, "");
}

/**
 * Single LANA SMS send attempt with a hard timeout. LANA's REST API accepts a
 * JSON body { phone, message } at https://api.lanasms.com/v1/send with a
 * Bearer token and returns { status: true|"success", message_id, ... } on
 * acceptance ({ status: false, message } on rejection — still HTTP 200).
 */
async function sendLanaAttempt(
  apiKey: string,
  phone: string,
  message: string,
): Promise<SmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        phone: formatPhoneLana(phone),
        sender_id: "WELILE",
        message,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    console.log(`[sms-otp] LANA response (${response.status}):`, text);

    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }

    const rawStatus = data?.status;
    const statusStr = String(rawStatus ?? "").toLowerCase();
    const accepted = rawStatus === true ||
      statusStr === "success" || statusStr === "true" ||
      statusStr === "ok" || statusStr === "sent" || statusStr === "queued";
    if (response.ok && accepted) {
      const fields = extractProviderFields(data);
      return { accepted: true, response: data, messageId: fields.messageId, cost: fields.cost };
    }

    if (!response.ok && (response.status >= 500 || response.status === 429)) {
      return { accepted: false, reason: "network_error", response: data };
    }
    const detail = String(data?.message ?? statusStr ?? "rejected")
      .toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
    return { accepted: false, reason: `lana_${response.status}_${detail || "rejected"}`, response: data };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    console.error(`[sms-otp] LANA attempt ${aborted ? "timed out" : "failed"}:`, error);
    return { accepted: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single Yoola SMS send attempt with a hard timeout. Yoola's REST API accepts
 * a JSON body { phone, message, api_key } at https://yoolasms.com/api/v1/send
 * and returns { status: "success", ... } on acceptance.
 */
async function sendYoolaAttempt(
  apiKey: string,
  phone: string,
  message: string,
): Promise<SmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        phone: formatPhoneYoola(phone),
        message,
        api_key: apiKey,
        sender: "WELILE",
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    console.log(`[sms-otp] Yoola response (${response.status}):`, text);

    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }

    const status = String(data?.status ?? "").toLowerCase();
    if (response.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued")) {
      const fields = extractProviderFields(data);
      return { accepted: true, response: data, messageId: fields.messageId, cost: fields.cost };
    }
    // HTTP-level success but ambiguous body — treat 2xx as accepted.
    if (response.ok && !data?.error && status === "") {
      const fields = extractProviderFields(data);
      return { accepted: true, response: data, messageId: fields.messageId, cost: fields.cost };
    }
    if (!response.ok && (response.status >= 500 || response.status === 429)) {
      return { accepted: false, reason: "network_error", response: data };
    }
    return { accepted: false, reason: `yoola_${response.status}_${status || "rejected"}`, response: data };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    console.error(`[sms-otp] Yoola attempt ${aborted ? "timed out" : "failed"}:`, error);
    return { accepted: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single gateway attempt with a hard timeout via AbortController so a slow or
 * stuck provider call can never block indefinitely.
 */
async function sendSMSAttempt(
  baseUrl: string,
  apiKey: string,
  params: URLSearchParams,
): Promise<SmsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "apiKey": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: params.toString(),
      signal: controller.signal,
    });

    const data = await response.json();
    console.log("[sms-otp] AT response:", JSON.stringify(data));

    const recipients = data?.SMSMessageData?.Recipients;
    if (recipients && recipients.length > 0) {
      const status = recipients[0].statusCode;
      // 101 = sent, 100 = queued (both mean the gateway accepted it)
      if (status === 101 || status === 100) {
        const fields = extractProviderFields(data);
        return { accepted: true, response: data, messageId: fields.messageId, cost: fields.cost };
      }
      // A definitive rejection from the gateway — retrying won't help.
      return { accepted: false, reason: `status_${status}`, response: data };
    }
    return { accepted: false, reason: "no_recipients", response: data };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    console.error(`[sms-otp] SMS attempt ${aborted ? "timed out" : "failed"}:`, error);
    return { accepted: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

// Reasons that are transient and worth retrying. Definitive gateway
// rejections (e.g. status_xxx, no_recipients) are not retried.
const RETRYABLE_REASONS = new Set(["timeout", "network_error"]);

/**
 * Send via LANA SMS (primary provider), with retries on transient failures.
 */
async function sendViaLana(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return { accepted: false, reason: "lana_not_configured" };

  let last: SmsResult = { accepted: false, reason: "network_error" };
  for (let attempt = 1; attempt <= SMS_MAX_ATTEMPTS; attempt++) {
    last = await sendLanaAttempt(apiKey, phone, message);
    if (last.accepted || !RETRYABLE_REASONS.has(last.reason ?? "")) return last;
    if (attempt < SMS_MAX_ATTEMPTS) {
      const backoff = SMS_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[sms-otp] LANA retry ${attempt}/${SMS_MAX_ATTEMPTS - 1} after ${last.reason} (backoff ${backoff}ms)`,
      );
      await sleep(backoff);
    }
  }
  return last;
}

/**
 * Send via Yoola SMS (primary provider while Africa's Talking comes online),
 * with retries on transient failures.
 */
async function sendViaYoola(phone: string, message: string): Promise<SmsResult> {
  // Trim to defend against stray whitespace/newlines pasted into the secret —
  // Yoola returns 403 "invalidkey" if the key has any surrounding whitespace.
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return { accepted: false, reason: "yoola_not_configured" };

  let last: SmsResult = { accepted: false, reason: "network_error" };
  for (let attempt = 1; attempt <= SMS_MAX_ATTEMPTS; attempt++) {
    last = await sendYoolaAttempt(apiKey, phone, message);
    if (last.accepted || !RETRYABLE_REASONS.has(last.reason ?? "")) return last;
    if (attempt < SMS_MAX_ATTEMPTS) {
      const backoff = SMS_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[sms-otp] Yoola retry ${attempt}/${SMS_MAX_ATTEMPTS - 1} after ${last.reason} (backoff ${backoff}ms)`,
      );
      await sleep(backoff);
    }
  }
  return last;
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");

  if (!apiKey || !username) {
    console.warn("[sms-otp] Missing Africa's Talking credentials");
    return { accepted: false, reason: "missing_credentials" };
  }

  // Determine base URL: sandbox vs production
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const formattedPhone = formatPhoneInternational(phone);

  const params = new URLSearchParams({
    username, from: "WELILE",
    to: formattedPhone,
    message,
  });

  let last: SmsResult = { accepted: false, reason: "network_error" };
  for (let attempt = 1; attempt <= SMS_MAX_ATTEMPTS; attempt++) {
    last = await sendSMSAttempt(baseUrl, apiKey, params);

    // Success or a definitive rejection — stop immediately.
    if (last.accepted || !RETRYABLE_REASONS.has(last.reason ?? "")) return last;

    // Transient failure — back off (exponential) before the next attempt.
    if (attempt < SMS_MAX_ATTEMPTS) {
      const backoff = SMS_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[sms-otp] retry ${attempt}/${SMS_MAX_ATTEMPTS - 1} after ${last.reason} (backoff ${backoff}ms)`,
      );
      await sleep(backoff);
    }
  }
  return last;
}

/**
 * Send the OTP SMS. Provider chain: Yoola (primary) → Africa's Talking → LANA.
 * Each provider is tried only if the previous one is unconfigured or fails, so
 * delivery is never blocked on a single provider. Returns the full ordered
 * trail of provider attempts (with timestamps) so we can prove a message was
 * only routed to ONE provider at a time and never double-sent.
 */
async function sendSMS(
  phone: string,
  message: string,
  options: { preferBackupRoute?: boolean; previousAcceptedProvider?: string | null } = {},
): Promise<SmsOutcome> {
  const attempts: ProviderAttempt[] = [];

  // Run a single provider, capturing precise start/finish timestamps so the
  // delivery log can show that providers fired strictly sequentially.
  const run = async (
    provider: string,
    fn: () => Promise<SmsResult>,
  ): Promise<SmsResult> => {
    const started_at = new Date().toISOString();
    const r = await fn();
    const finished_at = new Date().toISOString();
    attempts.push({
      provider,
      accepted: r.accepted,
      reason: r.reason,
      response: r.response,
      messageId: r.messageId ?? null,
      cost: r.cost ?? null,
      started_at,
      finished_at,
      attempted: !wasSkipped(r.reason),
    });
    return r;
  };

  type SmsProviderName = "yoola" | "africastalking" | "lana";
  type SmsProviderRoute = { provider: SmsProviderName; fn: () => Promise<SmsResult> };

  const primaryChain: SmsProviderRoute[] = [
    // Yoola is the PRIMARY OTP sender platform-wide: it delivers to the handset
    // reliably. Africa's Talking frequently returns "accepted" (statusCode
    // 101/100) without actually delivering, which traps users in a "code sent
    // but never arrives" loop. Only fall back to AT/LANA if Yoola is
    // unconfigured or rejects.
    { provider: "yoola", fn: () => sendViaYoola(phone, message) },
    { provider: "africastalking", fn: () => sendViaAfricasTalking(phone, message) },
    { provider: "lana", fn: () => sendViaLana(phone, message) },
  ];

  // POLICY: Yoola is ALWAYS tried first — on first sends AND on resends. The
  // other providers are fallbacks only, used when Yoola is unconfigured or
  // rejects. No rotation away from Yoola: the previous "rotate to backup on
  // resend" behaviour pushed resends onto AT and LANA, making resends less
  // likely to arrive.
  void options.previousAcceptedProvider;
  void options.preferBackupRoute;
  const chain = primaryChain;

  let bestReason: string | undefined;
  for (let i = 0; i < chain.length; i++) {
    const current = chain[i];
    if (i > 0) {
      console.warn(`[sms-otp] ${chain[i - 1].provider} not accepted; trying ${current.provider}`);
    }
    const result = await run(current.provider, current.fn);
    if (result.accepted) {
      // Gateway acceptance is the routing boundary. In particular, Yoola's
      // accepted response must end the chain: AT and LANA are fallbacks only
      // when Yoola is unconfigured or rejects the request.
      return { accepted: true, provider: current.provider, attempts };
    }
    if (result.reason && !wasSkipped(result.reason)) bestReason = result.reason;
  }

  return { accepted: false, reason: bestReason ?? attempts.at(-1)?.reason, attempts };

}

/**
 * Persist one row per provider attempt into `sms_delivery_log`, giving finance
 * leadership a precise, timestamped audit trail of which provider was tried,
 * in what order, and the final outcome. Best-effort — never throws.
 */
async function logSmsAttempts(
  admin: any,
  ctx: {
    phone: string;
    message: string;
    userId?: string | null;
    name?: string | null;
    referenceId?: string | null;
    source: string;
  },
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
      provider_message_id: a.messageId ?? null,
      cost: a.cost ?? null,
      reference_id: ctx.referenceId ?? null,
      source: ctx.source,
      provider_response: {
        provider_response: a.response ?? null,
        attempt_sequence: i + 1,
        total_attempts: outcome.attempts.length,
        started_at: a.started_at,
        finished_at: a.finished_at,
        reason: a.reason ?? null,
        final_provider: outcome.provider ?? null,
        final_accepted: outcome.accepted,
      },
    }));
    await admin.from("sms_delivery_log").insert(rows);
  } catch (e) {
    console.warn("[sms-otp] sms_delivery_log insert failed (non-critical):", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const action = body.action as string;
    const phone = (body.phone as string || "").replace(/\D/g, "");

    if (!phone || phone.length < 9) {
      return new Response(JSON.stringify({ error: "Valid phone number required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Normalize to local 9 digits for storage key
    const phoneKey = phone.slice(-9);

    if (action === "send") {
      const now = Date.now();
      const ip = clientIpFrom(req);
      const authUserId = await userIdFromAuth(adminClient, req);

      // Cross-phone caps: prevent bypassing the per-phone cooldown/hourly cap
      // by rotating phone numbers in the request body from the same user or IP.
      const hourAgoIso = new Date(now - HOUR_MS).toISOString();
      const dayAgoIso = new Date(now - DAY_MS).toISOString();

      const countEvents = async (
        filter: (q: any) => any,
        sinceIso: string,
      ): Promise<number> => {
        const query = filter(
          adminClient
            .from("otp_send_events")
            .select("id", { count: "exact", head: true })
            .gte("created_at", sinceIso),
        );
        const { count } = await query;
        return count ?? 0;
      };

      if (authUserId) {
        const [userHour, userDay] = await Promise.all([
          countEvents((q) => q.eq("user_id", authUserId), hourAgoIso),
          countEvents((q) => q.eq("user_id", authUserId), dayAgoIso),
        ]);
        if (userHour >= MAX_SENDS_PER_USER_HOUR) {
          return new Response(
            JSON.stringify({
              error: `Too many code requests. Please try again in about an hour.`,
              retry_after: 60 * 60,
            }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (userDay >= MAX_SENDS_PER_USER_DAY) {
          return new Response(
            JSON.stringify({
              error: `Daily verification-code limit reached. Please try again tomorrow.`,
              retry_after: 60 * 60 * 6,
            }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      if (ip) {
        const [ipHour, ipDay] = await Promise.all([
          countEvents((q) => q.eq("ip", ip), hourAgoIso),
          countEvents((q) => q.eq("ip", ip), dayAgoIso),
        ]);
        if (ipHour >= MAX_SENDS_PER_IP_HOUR || ipDay >= MAX_SENDS_PER_IP_DAY) {
          return new Response(
            JSON.stringify({
              error: `Too many verification requests from your network. Please try again later.`,
              retry_after: 60 * 60,
            }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      // Load existing record to enforce durable, DB-backed rate limits AND to
      // decide whether we can REUSE a still-valid code (see below).
      const { data: existing } = await adminClient
        .from("otp_verifications")
        .select("last_sent_at, send_count, send_window_start, otp_code, expires_at, verified, send_status, send_status_reason")
        .eq("phone", phoneKey)
        .maybeSingle();

      // Cooldown: minimum time between consecutive sends (survives reloads).
      if (existing?.last_sent_at) {
        const elapsed = now - new Date(existing.last_sent_at).getTime();
        const remaining = Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - elapsed) / 1000);
        if (remaining > 0) {
          return new Response(
            JSON.stringify({
              error: `Please wait ${remaining}s before requesting another code.`,
              retry_after: remaining,
            }),
            {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }
      }

      // Hourly cap: limit total sends within a rolling 1-hour window.
      let windowStart = existing?.send_window_start
        ? new Date(existing.send_window_start).getTime()
        : 0;
      let sendCount = existing?.send_count ?? 0;

      if (!windowStart || now - windowStart > HOUR_MS) {
        // Window expired (or first send) — reset.
        windowStart = now;
        sendCount = 0;
      }

      if (sendCount >= MAX_SENDS_PER_HOUR) {
        const resetInSeconds = Math.ceil((HOUR_MS - (now - windowStart)) / 1000);
        const resetIn = Math.ceil(resetInSeconds / 60);
        return new Response(
          JSON.stringify({
            error: `Too many code requests. Please try again in about ${resetIn} minute(s).`,
            retry_after: resetInSeconds,
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // ---------------------------------------------------------------------
      // CRITICAL FIX (recurring "Invalid code" loop):
      // SMS in our markets is often delivered late and out of order. If every
      // resend generated a NEW code and overwrote the previous one, a user who
      // finally receives an earlier SMS would type a code that no longer
      // matches the single stored value — failing forever no matter how
      // carefully they type. To make every SMS the user holds for this number
      // contain the SAME working code, we REUSE the existing code whenever it
      // is still valid (unverified and unexpired) and only mint a fresh code
      // when none is usable. Expiry is preserved so a code cannot be extended
      // indefinitely by repeated resends.
      // ---------------------------------------------------------------------
      const existingCodeUsable =
        !!existing?.otp_code &&
        existing?.verified === false &&
        !!existing?.expires_at &&
        new Date(existing.expires_at).getTime() > now;

      const otp = existingCodeUsable ? existing!.otp_code as string : generateOTP();
      const expiresAt = existingCodeUsable
        ? existing!.expires_at as string
        : new Date(now + 60 * 60 * 1000).toISOString(); // 1 hour expiry

      if (existingCodeUsable) {
        console.log(`[sms-otp] reusing still-valid code for ***${phoneKey.slice(-4)}`);
      }

      // Store OTP and updated rate-limit counters (upsert by phone)
      const { error: upsertError } = await adminClient
        .from("otp_verifications")
        .upsert(
          {
            phone: phoneKey,
            otp_code: otp,
            expires_at: expiresAt,
            attempts: 0,
            verified: false,
            last_sent_at: new Date(now).toISOString(),
            send_count: sendCount + 1,
            send_window_start: new Date(windowStart).toISOString(),
            send_status: "pending",
            send_status_reason: null,
            send_status_at: new Date(now).toISOString(),
          },
          { onConflict: "phone" }
        );

      if (upsertError) {
        console.error("[sms-otp] Upsert error:", upsertError);
        return new Response(JSON.stringify({ error: "Failed to generate OTP" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Record this send in the cross-phone rate-limit ledger. Best-effort;
      // never fail the send on a logging error.
      try {
        await adminClient.from("otp_send_events").insert({
          user_id: authUserId,
          phone: phoneKey,
          ip,
          outcome: existingCodeUsable ? "resent" : "sent",
        });
      } catch (e) {
        console.warn("[sms-otp] otp_send_events insert failed:", e);
      }

      // The OTP is already persisted above. We now wait *briefly* for the
      // gateway to ACCEPT the message (statusCode 101/100) so the button can
      // show real success/failure. Acceptance is fast and is NOT the same as
      // carrier delivery — we never wait for delivery. If the gateway is
      // unusually slow, we stop waiting, return optimistically, and let the
      // send finish in the background.
      /* Payout-number confirmation reuses the SAME wording family as the
         owner-consent SMS in _shared/payoutDestinationDeclaration.ts, so a
         person confirming a payout number reads one consistent sentence
         whichever route asked them. Any other purpose keeps the generic text.
         The OTP itself, its storage and its rate limits are unchanged. */
      const purpose = String(body.purpose ?? "").trim();
      const subjectName = String(body.subject_name ?? "").trim().slice(0, 80);
      const recipientName = String(body.recipient_name ?? "").trim().slice(0, 80);
      const last4 = phone.length >= 4 ? phone.slice(-4) : (String(body.phone_last4 ?? "").replace(/\D/g, "").slice(-4) || "????");
      /* A National ID link request reads the same way: the person who holds the
         ID is told who is asking and shares the code only if they agree. */
      const ninRef = String(body.nin_ref ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const message = purpose === "payout_number"
        ? `Welile: ${subjectName || "A Welile user"} wants to receive Welile payouts on a mobile money number ending ${last4} ` +
          `registered in your name (${recipientName || "the account holder"}). If you agree, share this code with them: ${otp}. ` +
          `If you did NOT authorise this, ignore this message.`
        : purpose === "national_id_link"
        ? `Welile: ${subjectName || "A Welile user"} wants to link their Welile account to your National ID ${ninRef || ""}. ` +
          `If you agree, share this code with them: ${otp}. You must also confirm it in the Welile app. ` +
          `If you did NOT authorise this, ignore this message.`
        : `Your Welile verification code is: ${otp}. It expires in 1 hour. Do not share this code.`;

      // Max time we'll block the client on gateway acceptance.
      const ACCEPTANCE_TIMEOUT_MS = 4000;
      const TIMED_OUT = Symbol("timed_out");

      const previousAcceptedProvider = existing?.send_status_reason ?? null;
      const previousAcceptedThisProvider =
        existing?.send_status === "accepted" &&
        typeof previousAcceptedProvider === "string" &&
        previousAcceptedProvider.startsWith("provider:");
      const preferBackupRoute = previousAcceptedThisProvider;
      if (preferBackupRoute) {
        console.log(`[sms-otp] resend for ***${phoneKey.slice(-4)} rotating to backup SMS route first`);
      }

      const smsPromise = sendSMS(phone, message, {
        preferBackupRoute,
        previousAcceptedProvider,
      });
      const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) =>
        setTimeout(() => resolve(TIMED_OUT), ACCEPTANCE_TIMEOUT_MS),
      );

      // Persist the gateway-acceptance outcome so the client can poll for it
      // via the "status" action without ever waiting on carrier delivery.
      const recordSendStatus = (result: SmsOutcome) =>
        adminClient
          .from("otp_verifications")
          .update({
            send_status: result.accepted ? "accepted" : "failed",
            send_status_reason: result.accepted ? `provider:${result.provider ?? "unknown"}` : (result.reason ?? null),
            send_status_at: new Date().toISOString(),
          })
          .eq("phone", phoneKey);

      const outcome = await Promise.race([smsPromise, timeoutPromise]);

      if (outcome === TIMED_OUT) {
        // Gateway slow — keep finishing in the background, respond optimistically.
        try {
          (globalThis as any).EdgeRuntime?.waitUntil?.(
            smsPromise
              .then(async (r) => {
                await recordSendStatus(r);
                await logSmsAttempts(
                  adminClient,
                  { phone, message, source: "sms-otp" },
                  r,
                );
                console.log(
                  `[sms-otp] late acceptance for ***${phoneKey.slice(-4)}: ${r.accepted ? "ok" : r.reason}`,
                );
              })
              .catch((err) => console.error("[sms-otp] background SMS error:", err)),
          );
        } catch (_) {
          // EdgeRuntime not available — nothing else to do.
        }
        return new Response(
          JSON.stringify({ success: true, pending: true, message: "Code is being sent" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Gateway responded in time — report the real result.
      await recordSendStatus(outcome);
      await logSmsAttempts(
        adminClient,
        { phone, message, source: "sms-otp" },
        outcome,
      );

      if (!outcome.accepted) {
        console.error(`[sms-otp] gateway rejected send to ***${phoneKey.slice(-4)}: ${outcome.reason}`);
        return new Response(
          JSON.stringify({ error: "Failed to send SMS. Please try again." }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      console.log(`[sms-otp] OTP accepted for ***${phoneKey.slice(-4)}`);
      return new Response(JSON.stringify({ success: true, message: "OTP sent successfully" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "status") {
      // Lightweight poll endpoint: reports whether the SMS gateway accepted the
      // most recent send for this phone. Never reflects carrier delivery.
      const { data: statusRow } = await adminClient
        .from("otp_verifications")
        .select("send_status, send_status_reason, send_status_at")
        .eq("phone", phoneKey)
        .maybeSingle();

      return new Response(
        JSON.stringify({
          status: statusRow?.send_status ?? "unknown",
          reason: statusRow?.send_status_reason ?? null,
          updated_at: statusRow?.send_status_at ?? null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "verify") {
      const otpCode = (body.otp as string || "").trim();
      if (!otpCode || otpCode.length !== 6) {
        return new Response(JSON.stringify({ error: "Please enter the 6-digit code" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Fetch stored OTP
      const { data: otpRecord, error: fetchError } = await adminClient
        .from("otp_verifications")
        .select("*")
        .eq("phone", phoneKey)
        .maybeSingle();

      if (fetchError || !otpRecord) {
        return new Response(JSON.stringify({ error: "No OTP found. Please request a new code." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check if already verified
      if (otpRecord.verified) {
        return new Response(JSON.stringify({ success: true, already_verified: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check expiration
      if (new Date(otpRecord.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: "OTP has expired. Please request a new code." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check max attempts (5)
      if (otpRecord.attempts >= 5) {
        return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Verify
      if (otpCode !== otpRecord.otp_code) {
        await adminClient
          .from("otp_verifications")
          .update({ attempts: otpRecord.attempts + 1 })
          .eq("phone", phoneKey);

        const remaining = 4 - otpRecord.attempts;
        return new Response(JSON.stringify({ error: `Invalid code. ${remaining} attempts remaining.` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Mark as verified
      await adminClient
        .from("otp_verifications")
        .update({ verified: true, verified_at: new Date().toISOString() })
        .eq("phone", phoneKey);

      console.log(`[sms-otp] Phone ***${phoneKey.slice(-4)} verified`);
      return new Response(JSON.stringify({ success: true, message: "Phone verified successfully" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "send_custom" || action === "custom") {
      const message = (body.message as string || "").trim();
      if (!message) {
        return new Response(JSON.stringify({ error: "Message required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const sent = await sendSMS(phone, message);
      await logSmsAttempts(
        adminClient,
        { phone, message, source: "sms-otp:custom" },
        sent,
      );
      if (!sent.accepted) {
        return new Response(JSON.stringify({ error: "Failed to send SMS" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action. Use 'send', 'status', 'verify', or 'custom'." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[sms-otp] Error:", msg);
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
