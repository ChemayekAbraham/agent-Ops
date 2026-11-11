import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logOtpUsage } from "../_shared/otpUsageLog.ts";
import { redactSmsCodes } from "../_shared/redactSmsCodes.ts";
import { bearerHasSub, noUserResult } from "../_shared/bearerHasSub.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Durable, database-backed send limits (otp_reserve_send, shared with sms-otp).
// An in-memory counter resets on every cold start and is not shared between
// function instances, so it cannot stop someone requesting codes in a loop.
const MAX_RESETS_PER_HOUR = 3;
const RESEND_COOLDOWN_SECONDS = 60;
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

const ADMIN_ACTION_ROLES = ["manager", "super_admin", "cto"];

// Result of requireAdminCaller: either a Response to send straight back
// (denied), or the signed-in admin's user id (callerId).
type AdminCheck =
  | { denied: Response; callerId: null }
  | { denied: null; callerId: string };

// Admin actions need a real signed-in caller holding an enabled privileged
// role. verify_jwt is off for this function, so we validate the token here.
async function requireAdminCaller(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  req: Request,
): Promise<AdminCheck> {
  const deny = (status: number, error: string): AdminCheck => ({
    denied: new Response(JSON.stringify({ error }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    }),
    callerId: null,
  });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return deny(401, "Unauthorized");
  const { data: authData, error: authError } = await (bearerHasSub(token) ? adminClient.auth.getUser(token) : noUserResult());
  const caller = authData?.user;
  if (authError || !caller) return deny(401, "Unauthorized");
  const { data: roleRows, error: roleError } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", caller.id)
    .eq("enabled", true)
    .in("role", ADMIN_ACTION_ROLES);
  if (roleError) return deny(500, "Authorisation check failed");
  if (!roleRows || roleRows.length === 0) return deny(403, "Forbidden");
  return { denied: null, callerId: caller.id };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Durable record of a privileged action. audit_logs is append-only in
// production (triggers block UPDATE, DELETE and TRUNCATE). It is written BEFORE
// the action and fails closed: if the record cannot be saved, the action is
// refused. Returns an error Response, or null when the record was saved.
// NEVER put the new password (or anything secret) in the metadata.
async function writeAdminAudit(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  req: Request,
  callerId: string,
  actionType: "admin_password_reset" | "admin_delete_user",
  targetUserId: string,
  via: string,
): Promise<Response | null> {
  const { error } = await adminClient.from("audit_logs").insert({
    user_id: callerId,
    actor_id: callerId,
    target_user_id: targetUserId,
    action_type: actionType,
    action: actionType,
    table_name: "auth.users",
    record_id: targetUserId,
    ip_address: clientIpFrom(req),
    user_agent: req.headers.get("user-agent"),
    metadata: { function: "password-reset-sms", via },
  });
  if (error) {
    console.error("[password-reset-sms] audit write failed, refusing the action:", error.message);
    return new Response(JSON.stringify({ error: "Could not record this action. Please try again." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

// 6-digit code from the platform's cryptographically secure generator
// (Math.random is predictable). A draw at or above LIMIT is thrown away and
// redrawn, so every code from 000000 to 999999 is equally likely.
function generateOTP(): string {
  const LIMIT = Math.floor(0x100000000 / 1000000) * 1000000;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= LIMIT);
  return String(buf[0] % 1000000).padStart(6, "0");
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

  type ProviderName = "yoola" | "africastalking" | "lana";
  const primaryChain: Array<{ provider: ProviderName; fn: () => Promise<SmsResult> }> = [
    { provider: "yoola", fn: () => sendViaYoola(phone, message) },
    { provider: "africastalking", fn: () => sendViaAfricasTalking(phone, message) },
    { provider: "lana", fn: () => sendViaLana(phone, message) },
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
      message: redactSmsCodes(ctx.message),
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
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({ phone: String(phoneLana), sender_id: "WELILE", message }).toString(),
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

      const check = await requireAdminCaller(adminClient, req);
      if (check.denied) return check.denied;

      if (!UUID_RE.test(userId) || !newPassword || newPassword.length < 6) {
        return new Response(JSON.stringify({ error: "user_id and new_password (min 6 chars) required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const auditFailed = await writeAdminAudit(adminClient, req, check.callerId, "admin_password_reset", userId, "admin_reset");
      if (auditFailed) return auditFailed;

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

      const check = await requireAdminCaller(adminClient, req);
      if (check.denied) return check.denied;

      if (!UUID_RE.test(userId) || !newPassword || newPassword.length < 6) {
        return new Response(JSON.stringify({ error: "user_id and new_password required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const auditFailed = await writeAdminAudit(adminClient, req, check.callerId, "admin_password_reset", userId, "admin_reset_password");
      if (auditFailed) return auditFailed;

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

      const check = await requireAdminCaller(adminClient, req);
      if (check.denied) return check.denied;

      if (!UUID_RE.test(userId)) {
        return new Response(JSON.stringify({ error: "user_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const auditFailed = await writeAdminAudit(adminClient, req, check.callerId, "admin_delete_user", userId, "admin_delete_user");
      if (auditFailed) return auditFailed;

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
      // Verify user exists
      const { data: profile } = await adminClient
        .from("profiles")
        .select("id, full_name, phone")
        .in("phone", phoneFormats)
        .limit(1)
        .maybeSingle();

      // Do not reveal whether this phone has an account: answer exactly as if a
      // code had been sent, but send nothing and store nothing.
      if (!profile) {
        console.log(`[password-reset-sms] reset requested for an unregistered number ***${phoneKey.slice(-4)}`);
        return new Response(JSON.stringify({ success: true, message: "Reset code sent" }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Reset codes live in otp_verifications under a reset-specific phone key.
      const resetKey = `reset_${phoneKey}`;
      // Previous send's provider, read only to choose the SMS route (not a limit check).
      const { data: existingReset } = await adminClient
        .from("otp_verifications")
        .select("send_status, send_status_reason")
        .eq("phone", resetKey)
        .maybeSingle();

      // Every send limit is checked and counted in ONE locked database step, so
      // simultaneous requests cannot all slip under a cap. Password reset SMS can
      // arrive late/out of order, so a still-valid code is reused (every SMS on
      // the handset keeps working) WITHOUT resetting its wrong-try count; only a
      // brand-new code starts at zero tries.
      const { data: reserve, error: reserveError } = await adminClient.rpc("otp_reserve_send", {
        p_phone: resetKey,
        p_user_id: null,
        p_ip: clientIpFrom(req),
        p_new_code: generateOTP(),
        p_ttl_seconds: 3600,
        p_cooldown_seconds: RESEND_COOLDOWN_SECONDS,
        p_max_phone_hour: MAX_RESETS_PER_HOUR,
        p_max_user_hour: MAX_RESETS_PER_HOUR,
        p_max_user_day: MAX_RESETS_PER_HOUR * 3,
        p_max_ip_hour: MAX_SENDS_PER_IP_HOUR,
        p_max_ip_day: MAX_SENDS_PER_IP_DAY,
      });
      if (reserveError || !reserve) {
        console.error("[password-reset-sms] reserve error:", reserveError);
        return new Response(JSON.stringify({ error: "Failed to generate reset code" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!reserve.ok) {
        return new Response(JSON.stringify({ error: reserve.error, retry_after: reserve.retry_after }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const otp = String(reserve.otp);

      const message = `Welile reset code: ${otp}. Expires in 1 hour. Never share this code.`;
      const preferBackupRoute = reserve.reused === true && existingReset?.send_status === "accepted";
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
      // A code that has already reset a password is single-use.
      if (otpRecord.verified) {
        return new Response(JSON.stringify({ error: "Reset code has expired or was already used. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (new Date(otpRecord.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: "Reset code has expired. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Use up one attempt BEFORE comparing, atomically in the database, so a
      // burst of parallel guesses cannot all read the same old count
      // (register_otp_attempt, doc 251). Every guess is counted, right or wrong.
      const { data: attemptsUsed, error: attemptError } = await adminClient
        .rpc("register_otp_attempt", { p_otp_id: otpRecord.id });
      // Fail closed: if we cannot count the guess, we do not check it.
      if (attemptError || attemptsUsed === null) {
        console.error("[password-reset-sms] register_otp_attempt failed:", attemptError?.message);
        return new Response(JSON.stringify({ error: "Could not verify code. Please try again." }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (attemptsUsed > 5) {
        return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (otpCode !== otpRecord.otp_code) {
        const remaining = Math.max(0, 5 - attemptsUsed);
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

      // A code that has already reset a password is single-use.
      if (otpRecord.verified) {
        return new Response(JSON.stringify({ error: "Reset code has expired or was already used. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (new Date(otpRecord.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: "Reset code has expired. Please request a new one." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Use up one attempt BEFORE comparing, atomically in the database, so a
      // burst of parallel guesses cannot all read the same old count. This is
      // the gate in front of "set a new password on every account for this
      // phone", so it must hold under load (register_otp_attempt, doc 251).
      const { data: attemptsUsed, error: attemptError } = await adminClient
        .rpc("register_otp_attempt", { p_otp_id: otpRecord.id });
      // Fail closed: if we cannot count the guess, we do not check it.
      if (attemptError || attemptsUsed === null) {
        console.error("[password-reset-sms] register_otp_attempt failed:", attemptError?.message);
        return new Response(JSON.stringify({ error: "Could not verify code. Please try again." }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (attemptsUsed > 5) {
        return new Response(JSON.stringify({ error: "Too many failed attempts. Please request a new code." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (otpCode !== otpRecord.otp_code) {
        await logOtpUsage(adminClient, "password_reset", "verify_failed", phoneKey, "password-reset-sms");
        const remaining = Math.max(0, 5 - attemptsUsed);
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
