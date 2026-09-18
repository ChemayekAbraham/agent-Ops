import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logOtpUsage } from "../_shared/otpUsageLog.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// In-memory rate limiting
const resetAttempts = new Map<string, { count: number; firstAt: number }>();
const MAX_RESETS_PER_HOUR = 3;
const TWILIO_GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
const TWILIO_SENDER = "WELILE";

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const record = resetAttempts.get(key);
  if (!record || now - record.firstAt > 3600000) {
    resetAttempts.set(key, { count: 1, firstAt: now });
    return true;
  }
  if (record.count >= MAX_RESETS_PER_HOUR) return false;
  record.count++;
  return true;
}

function generateOTP(): string {
  let otp = "";
  for (let i = 0; i < 6; i++) {
    otp += Math.floor(Math.random() * 10).toString();
  }
  return otp;
}

// Known country code prefixes (longest first for greedy matching)
const KNOWN_COUNTRY_CODES = [
  '256', '254', '255', '250', '257', '211', '243', '234', '27', '44', '1',
  '91', '86', '33', '49', '81', '82', '61', '55', '7', '966', '971', '20',
  '212', '233', '225', '221', '260', '263', '267', '251',
];

function formatPhoneInternational(rawPhone: string): string {
  let digits = rawPhone.replace(/\D/g, "");
  for (const code of KNOWN_COUNTRY_CODES) {
    if (digits.startsWith(code) && digits.length > code.length + 5) {
      return "+" + digits;
    }
  }
  if (digits.startsWith("0")) {
    digits = "256" + digits.slice(1);
  }
  return "+" + digits;
}

interface ProviderAttempt {
  provider: string;
  accepted: boolean;
  reason?: string;
  response?: unknown;
  messageId?: string | null;
  cost?: string | null;
  started_at: string;
  finished_at: string;
  attempted: boolean;
}
interface SmsOutcome {
  ok: boolean;
  reason?: string;
  provider?: string;
  attempts: ProviderAttempt[];
}

interface SmsResult {
  ok: boolean;
  reason?: string;
  response?: unknown;
  messageId?: string | null;
  cost?: string | null;
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

function wasSkipped(reason?: string): boolean {
  return reason === "SMS service not configured" ||
    (typeof reason === "string" && reason.endsWith("not_configured"));
}

async function sendSMS(
  phone: string,
  message: string,
  options: { preferBackupRoute?: boolean; previousAcceptedProvider?: string | null } = {},
): Promise<SmsOutcome> {
  // Default chain: Yoola (primary) → Africa's Talking → LANA.
  // For resends where Yoola accepted but the handset never got the SMS, rotate
  // to the next provider first. Gateway acceptance is not handset delivery.
  const attempts: ProviderAttempt[] = [];
  const run = async (provider: string, fn: () => Promise<SmsResult>) => {
    const started_at = new Date().toISOString();
    const r = await fn();
    const finished_at = new Date().toISOString();
    attempts.push({
      provider,
      accepted: r.ok,
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

  type ProviderName = "yoola" | "africastalking" | "lana" | "twilio";
  const primaryChain: Array<{ provider: ProviderName; fn: () => Promise<SmsResult> }> = [
    { provider: "yoola", fn: () => sendViaYoola(phone, message) },
    { provider: "africastalking", fn: () => sendViaAfricasTalking(phone, message) },
    { provider: "lana", fn: () => sendViaLana(phone, message) },
    { provider: "twilio", fn: () => sendViaTwilio(phone, message) },
  ];
  // POLICY: Yoola is ALWAYS first, on first sends and on resends. The other
  // providers are fallbacks only (used when Yoola is unconfigured or rejects).
  void options.previousAcceptedProvider;
  void options.preferBackupRoute;
  const chain = primaryChain;

  let bestReason: string | undefined;
  for (let i = 0; i < chain.length; i++) {
    const current = chain[i];
    if (i > 0) console.warn(`[password-reset-sms] ${chain[i - 1].provider} not accepted; trying ${current.provider}`);
    const result = await run(current.provider, current.fn);
    if (result.ok) return { ok: true, provider: current.provider, attempts };
    if (result.reason && !wasSkipped(result.reason)) bestReason = result.reason;
  }

  return { ok: false, reason: bestReason ?? attempts.at(-1)?.reason, attempts };
}

/** Best-effort per-provider attempt audit trail into sms_delivery_log. */
async function logSmsAttempts(
  admin: any,
  ctx: { phone: string; message: string; userId?: string | null; name?: string | null; referenceId?: string | null; source: string },
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
        final_accepted: outcome.ok,
      },
    }));
    await admin.from("sms_delivery_log").insert(rows);
  } catch (e) {
    console.warn("[password-reset-sms] sms_delivery_log insert failed (non-critical):", e);
  }
}

async function sendViaLana(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return { ok: false, reason: "lana_not_configured" };
  try {
    const phoneLana = formatPhoneInternational(phone).replace(/^\+/, "");
    const response = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ phone: phoneLana, sender_id: "WELILE", message}),
    });
    const text = await response.text();
    console.log(`[password-reset-sms] LANA response (${response.status}):`, text);
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const rawStatus = data?.status;
    const statusStr = String(rawStatus ?? "").toLowerCase();
    const accepted = rawStatus === true ||
      statusStr === "success" || statusStr === "true" ||
      statusStr === "ok" || statusStr === "sent" || statusStr === "queued";
    if (response.ok && accepted) {
      const fields = extractProviderFields(data);
      return { ok: true, response: data, messageId: fields.messageId, cost: fields.cost };
    }
    return { ok: false, reason: `LANA rejected (${response.status}: ${data?.message ?? statusStr})`, response: data };
  } catch (error) {
    console.error("[password-reset-sms] LANA error:", error);
    return { ok: false, reason: "Network error contacting SMS provider" };
  }
}

async function sendViaYoola(phone: string, message: string): Promise<SmsResult> {
  // Trim to defend against stray whitespace/newlines pasted into the secret —
  // Yoola returns 403 "invalidkey" if the key has any surrounding whitespace.
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return { ok: false, reason: "yoola_not_configured" };
  try {
    const phoneYoola = formatPhoneInternational(phone).replace(/^\+/, "");
    const response = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ phone: phoneYoola, message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await response.text();
    console.log(`[password-reset-sms] Yoola response (${response.status}):`, text);
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const status = String(data?.status ?? "").toLowerCase();
    if (response.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued" || (!data?.error && status === ""))) {
      const fields = extractProviderFields(data);
      return { ok: true, response: data, messageId: fields.messageId, cost: fields.cost };
    }
    return { ok: false, reason: `Yoola rejected (${response.status})`, response: data };
  } catch (error) {
    console.error("[password-reset-sms] Yoola error:", error);
    return { ok: false, reason: "Network error contacting SMS provider" };
  }
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.warn("[password-reset-sms] Missing AT credentials");
    return { ok: false, reason: "SMS service not configured" };
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const formattedPhone = formatPhoneInternational(phone);

  try {
    const params = new URLSearchParams({ username, from: "WELILE", to: formattedPhone, message });
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "apiKey": apiKey, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: params.toString(),
    });
    const data = await response.json();
    console.log("[password-reset-sms] AT response:", JSON.stringify(data));
    const recipients = data?.SMSMessageData?.Recipients;
    if (recipients?.length > 0) {
      const r = recipients[0];
      const status = r.statusCode;
      if (status === 101 || status === 100) {
        const fields = extractProviderFields(data);
        return { ok: true, response: data, messageId: fields.messageId, cost: fields.cost };
      }
      if (status === 405 || /InsufficientBalance/i.test(r.status || "")) {
        return { ok: false, reason: "SMS service is temporarily out of credit. Please try email reset or contact support.", response: data };
      }
      return { ok: false, reason: r.status || "SMS provider rejected the request", response: data };
    }
    return { ok: false, reason: "No recipient response from SMS provider", response: data };
  } catch (error) {
    console.error("[password-reset-sms] SMS error:", error);
    return { ok: false, reason: "Network error contacting SMS provider" };
  }
}

async function sendViaTwilio(phone: string, message: string): Promise<SmsResult> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const twilioKey = Deno.env.get("TWILIO_API_KEY");
  if (!lovableKey || !twilioKey) return { ok: false, reason: "twilio_not_configured" };

  try {
    const formattedPhone = formatPhoneInternational(phone);
    const response = await fetch(`${TWILIO_GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": twilioKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({ To: formattedPhone, From: TWILIO_SENDER, Body: message }).toString(),
    });
    const text = await response.text();
    console.log(`[password-reset-sms] Twilio response (${response.status}):`, text);
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    const status = String(data?.status ?? "").toLowerCase();
    const accepted = ["queued", "accepted", "sending", "sent", "delivered"].includes(status);
    if (response.ok && accepted) {
      return { ok: true, response: data, messageId: firstString(data?.sid, data?.messageId, data?.message_id), cost: null };
    }
    return { ok: false, reason: String(data?.error_message ?? data?.message ?? `Twilio rejected (${response.status})`), response: data };
  } catch (error) {
    console.error("[password-reset-sms] Twilio error:", error);
    return { ok: false, reason: "Network error contacting SMS provider" };
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

    const body = await req.json();
    const action = body.action as string;
    const phone = (body.phone as string || "").replace(/\D/g, "");

    if (!phone || phone.length < 9) {
      return new Response(JSON.stringify({ error: "Valid phone number required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const phoneKey = phone.slice(-9);
    const phoneFormats = [`0${phoneKey}`, `256${phoneKey}`, phoneKey, `+256${phoneKey}`];

    // Admin-only direct password reset (no OTP needed)
    if (action === "admin_reset") {
      const userId = (body.user_id as string || "").trim();
      const newPassword = (body.new_password as string || "").trim();
      const authHeader = req.headers.get("authorization") || "";

      if (!userId || !newPassword || newPassword.length < 6) {
        return new Response(JSON.stringify({ error: "user_id and new_password (min 6 chars) required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Verify caller is a manager
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: updateError } = await adminClient.auth.admin.updateUserById(userId, {
        password: newPassword,
        email_confirm: true,
      });
      if (updateError) {
        console.error("[password-reset-sms] Admin reset error:", updateError);
        return new Response(JSON.stringify({ error: "Failed to reset password" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[password-reset-sms] Admin password reset for user ${userId}`);
      return new Response(JSON.stringify({ success: true, message: "Password reset successfully" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin-only: reset a user's password
    if (action === "admin_reset_password") {
      const userId = (body.user_id as string || "").trim();
      const newPassword = (body.new_password as string || "").trim();

      if (!userId || !newPassword) {
        return new Response(JSON.stringify({ error: "user_id and new_password required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: resetError } = await adminClient.auth.admin.updateUserById(userId, {
        password: newPassword,
        email_confirm: true,
      });
      if (resetError) {
        console.error("[password-reset-sms] Admin reset error:", resetError);
        return new Response(JSON.stringify({ error: "Failed to reset password: " + resetError.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[password-reset-sms] Admin reset password for user ${userId}`);
      return new Response(JSON.stringify({ success: true, message: "Password reset successfully" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_delete_user") {
      const userId = (body.user_id as string || "").trim();
      const authHeader = req.headers.get("authorization") || "";

      if (!userId) {
        return new Response(JSON.stringify({ error: "user_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
      if (deleteError) {
        console.error("[password-reset-sms] Admin delete error:", deleteError);
        return new Response(JSON.stringify({ error: "Failed to delete user" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[password-reset-sms] Admin deleted auth user ${userId}`);
      return new Response(JSON.stringify({ success: true, message: "User deleted" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "send") {
      if (!checkRateLimit(phoneKey)) {
        return new Response(JSON.stringify({ error: "Too many reset requests. Please try again later." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Verify user exists
      const { data: profile } = await adminClient
        .from("profiles")
        .select("id, full_name, phone")
        .in("phone", phoneFormats)
        .limit(1)
        .maybeSingle();

      if (!profile) {
        return new Response(JSON.stringify({ error: "No account found with this phone number." }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const resetKey = `reset_${phoneKey}`;
      const now = Date.now();
      const { data: existingReset } = await adminClient
        .from("otp_verifications")
        .select("otp_code, expires_at, verified, send_status, send_status_reason")
        .eq("phone", resetKey)
        .maybeSingle();

      // Password reset SMS can also arrive late/out of order. Reuse a still-valid
      // reset code so every SMS currently on the user's phone contains a working
      // code, then rotate provider if the previous accepted route didn't reach
      // the handset.
      const existingCodeUsable =
        !!existingReset?.otp_code &&
        existingReset?.verified === false &&
        !!existingReset?.expires_at &&
        new Date(existingReset.expires_at).getTime() > now;
      const otp = existingCodeUsable ? existingReset!.otp_code as string : generateOTP();
      const expiresAt = existingCodeUsable
        ? existingReset!.expires_at as string
        : new Date(now + 60 * 60 * 1000).toISOString();

      // Store OTP using otp_verifications table with a reset-specific phone key
      const { error: upsertError } = await adminClient
        .from("otp_verifications")
        .upsert({
          phone: resetKey,
          otp_code: otp,
          expires_at: expiresAt,
          attempts: 0,
          verified: false,
          send_status: "pending",
          send_status_reason: null,
          send_status_at: new Date(now).toISOString(),
        }, { onConflict: "phone" });

      if (upsertError) {
        console.error("[password-reset-sms] Upsert error:", upsertError);
        return new Response(JSON.stringify({ error: "Failed to generate reset code" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const message = `Your Welile password reset code is: ${otp}. It expires in 1 hour. Do not share this code with anyone.`;
      const preferBackupRoute = existingCodeUsable && existingReset?.send_status === "accepted";
      if (preferBackupRoute) {
        console.log(`[password-reset-sms] resend for ***${phoneKey.slice(-4)} rotating to backup SMS route first`);
      }
      const sent = await sendSMS(phone, message, {
        preferBackupRoute,
        previousAcceptedProvider: existingReset?.send_status_reason ?? null,
      });
      await adminClient
        .from("otp_verifications")
        .update({
          send_status: sent.ok ? "accepted" : "failed",
          send_status_reason: sent.ok ? `provider:${sent.provider ?? "unknown"}` : (sent.reason ?? null),
          send_status_at: new Date().toISOString(),
        })
        .eq("phone", resetKey);
      await logSmsAttempts(adminClient, {
        phone,
        message,
        userId: profile.id,
        name: profile.full_name ?? null,
        referenceId: resetKey,
        source: "password-reset-sms",
      }, sent);

      if (!sent.ok) {
        // Return 200 with structured error to avoid frontend blank-screen on 500.
        return new Response(JSON.stringify({
          success: false,
          error: sent.reason || "Failed to send SMS. Please try again.",
          fallback: true,
        }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[password-reset-sms] Reset OTP sent to ***${phoneKey.slice(-4)}`);
      return new Response(JSON.stringify({ success: true, message: "Reset code sent" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify") {
      // Lightweight pre-check so the UI can validate the OTP BEFORE the user
      // types a new password. Does not consume an attempt on success; on a
      // wrong code we increment attempts (mirrors verify-and-reset).
      const otpCode = (body.otp as string || "").trim();
      if (!otpCode || otpCode.length !== 6) {
        return new Response(JSON.stringify({ error: "Please enter the 6-digit code" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const resetKey = `reset_${phoneKey}`;
      const { data: otpRecord } = await adminClient
        .from("otp_verifications")
        .select("*")
        .eq("phone", resetKey)
        .maybeSingle();

      if (!otpRecord) {
        return new Response(JSON.stringify({ error: "No reset code found. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (new Date(otpRecord.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: "Reset code has expired. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (otpRecord.attempts >= 5) {
        return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (otpCode !== otpRecord.otp_code) {
        await adminClient
          .from("otp_verifications")
          .update({ attempts: otpRecord.attempts + 1 })
          .eq("phone", resetKey);
        const remaining = Math.max(0, 4 - otpRecord.attempts);
        return new Response(JSON.stringify({ error: `Invalid code. ${remaining} attempts remaining.` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify-and-reset") {
      const otpCode = (body.otp as string || "").trim();
      const newPassword = (body.new_password as string || "").trim();

      if (!otpCode || otpCode.length !== 6) {
        return new Response(JSON.stringify({ error: "Please enter the 6-digit code" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!newPassword || newPassword.length < 6) {
        return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const resetKey = `reset_${phoneKey}`;
      const { data: otpRecord } = await adminClient
        .from("otp_verifications")
        .select("*")
        .eq("phone", resetKey)
        .maybeSingle();

      if (!otpRecord) {
        return new Response(JSON.stringify({ error: "No reset code found. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (new Date(otpRecord.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: "Reset code has expired. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (otpRecord.attempts >= 5) {
        return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (otpCode !== otpRecord.otp_code) {
        await adminClient
          .from("otp_verifications")
          .update({ attempts: otpRecord.attempts + 1 })
          .eq("phone", resetKey);
        await logOtpUsage(adminClient, "password_reset", "verify_failed", phoneKey, "password-reset-sms");
        const remaining = 4 - otpRecord.attempts;
        return new Response(JSON.stringify({ error: `Invalid code. ${remaining} attempts remaining.` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // OTP verified — reset the password on EVERY active account tied to this
      // phone. A single phone can map to multiple auth UUIDs (placeholder
      // @welile.user emails, real emails, agent variants). The sign-in flow
      // resolves candidates by last-9 digits across profiles + auth.users and
      // races them, so if we only reset one account the user may land on a
      // different account that still holds the OLD password — surfacing as
      // "invalid password" right after a successful reset. Resetting all
      // matching accounts guarantees the new password works whichever one
      // login lands on.
      const { data: idRows, error: idErr } = await adminClient.rpc("get_user_ids_by_phone", {
        phone_variants: phoneFormats,
      });
      if (idErr) {
        console.error("[password-reset-sms] get_user_ids_by_phone error:", idErr);
      }

      const userIds = new Set<string>(
        Array.isArray(idRows) ? (idRows as { user_id: string }[]).map((r) => r.user_id).filter(Boolean) : [],
      );

      // Fallback: if the RPC returned nothing (e.g. profile phone stored in an
      // unexpected format), fall back to a direct profiles lookup so we never
      // regress below the previous single-account behaviour.
      if (userIds.size === 0) {
        const { data: profileRows } = await adminClient
          .from("profiles")
          .select("id")
          .in("phone", phoneFormats);
        (profileRows ?? []).forEach((p: { id: string }) => p?.id && userIds.add(p.id));
      }

      if (userIds.size === 0) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let anySuccess = false;
      let weakPasswordHit = false;
      let lastErrorMessage: string | null = null;
      for (const uid of userIds) {
        const { error: updateError } = await adminClient.auth.admin.updateUserById(uid, {
          password: newPassword,
          // SMS reset proves phone ownership. Confirm the auth email too so
          // real-email accounts that never clicked email verification are not
          // left unable to sign in after a successful password reset.
          email_confirm: true,
        });
        if (!updateError) {
          anySuccess = true;
          continue;
        }
        const errAny = updateError as unknown as { code?: string; message?: string };
        const isWeak =
          errAny?.code === "weak_password" ||
          /weak|pwned|known to be weak|easy to guess/i.test(errAny?.message ?? "");
        if (isWeak) weakPasswordHit = true;
        lastErrorMessage = errAny?.message ?? "update_failed";
        console.error(`[password-reset-sms] Password update error for ${uid}:`, updateError);
      }

      if (!anySuccess) {
        // A weak-password rejection is user-actionable and applies to every
        // account, so surface it first.
        const friendly = weakPasswordHit
          ? "This password has appeared in known data breaches, so it can't be used. Please choose a different, more unique password."
          : "Failed to reset password. Please try again.";
        return new Response(JSON.stringify({ error: friendly, code: weakPasswordHit ? "weak_password" : null }), {
          status: weakPasswordHit ? 400 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Mark OTP as used
      await adminClient
        .from("otp_verifications")
        .update({ verified: true, verified_at: new Date().toISOString() })
        .eq("phone", resetKey);
      await logOtpUsage(adminClient, "password_reset", "verify_success", phoneKey, "password-reset-sms");

      console.log(`[password-reset-sms] Password reset successful for ***${phoneKey.slice(-4)} across ${userIds.size} account(s)`);
      return new Response(JSON.stringify({ success: true, message: "Password reset successfully", accounts_updated: userIds.size }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[password-reset-sms] Error:", msg);
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
