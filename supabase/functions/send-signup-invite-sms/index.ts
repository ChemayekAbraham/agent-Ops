import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
// Sends a sign-up invite SMS to a tenant and/or landlord when an agent posts a
// rent request. For each recipient we:
//   1. Check if they are already a Welile user (by phone). If so, skip — no SMS.
//   2. If not, make sure there's a pending invite (reuse the activation token
//      from register-tenant for tenants, or create a supporter_invites row for
//      landlords) and text them a one-tap /join link to claim their free account.
//
// Fire-and-forget from the client: it must never block or fail rent submission.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const VALID_ROLES = ["tenant", "landlord"] as const;
type InviteRole = (typeof VALID_ROLES)[number];

function toDigits(v: string): string {
  return (v || "").replace(/[^0-9]/g, "");
}

function last9(v: string): string | null {
  const d = toDigits(v);
  if (!d) return null;
  const l9 = d.length >= 9 ? d.slice(-9) : d;
  return l9.length === 9 ? l9 : null;
}

function formatPhoneInternational(phone: string): string {
  const digits = toDigits(phone);
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

// Yoola is the PRIMARY SMS provider. JSON body { phone, message, api_key }
// posted to https://yoolasms.com/api/v1/send; { status: "success" } = accepted.
// Phone is digits only with country code, no leading "+".
async function sendViaYoola(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  // Trim — Yoola returns 403 "invalidkey" if the key has surrounding whitespace.
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) {
    console.warn("[send-signup-invite-sms] Yoola not configured");
    return { ok: false, reason: "yoola_not_configured" };
  }
  const phoneYoola = formatPhoneInternational(phone).replace(/^\+/, "");
  if (!phoneYoola) return { ok: false, reason: "invalid_phone" };
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: phoneYoola, message, api_key: apiKey, sender: "WELILE" }),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { data = null; }
    const status = String(data?.status ?? "").toLowerCase();
    // Treat any successful HTTP response that Yoola did not explicitly reject as
    // "accepted" so Africa's Talking never double-sends after a real delivery.
    const ok =
      res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    console.log(`[send-signup-invite-sms] Yoola to=${phoneYoola} ok=${ok} status=${res.status}`);
    return ok ? { ok: true } : { ok: false, reason: `yoola_${res.status}_${status || "rejected"}` };
  } catch (err) {
    console.error("[send-signup-invite-sms] Yoola send failed:", err);
    return { ok: false, reason: "network_error" };
  }
}

// Africa's Talking — used only as a FALLBACK when Yoola is not accepted.
async function sendViaAfricasTalking(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[send-signup-invite-sms] Missing AT credentials");
    return { ok: false, reason: "missing_credentials" };
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const to = formatPhoneInternational(phone);
  if (!to) return { ok: false, reason: "invalid_phone" };

  try {
    const body = new URLSearchParams({ username, from: "WELILE", to, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch {
      console.error("[send-signup-invite-sms] Non-JSON AT response:", raw);
      return { ok: false, reason: "non_json_response" };
    }
    const recipients = data?.SMSMessageData?.Recipients || [];
    const ok = recipients.some(
      (r: any) => r.statusCode === 100 || r.statusCode === 101,
    );
    console.log(`[send-signup-invite-sms] AT to=${to} ok=${ok} status=${res.status}`);
    return ok ? { ok: true } : { ok: false, reason: `at_status_${recipients[0]?.statusCode ?? "none"}` };
  } catch (err) {
    console.error("[send-signup-invite-sms] AT send failed:", err);
    return { ok: false, reason: "network_error" };
  }
}

interface ProviderAttempt {
  provider: string;
  accepted: boolean;
  reason?: string;
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
function wasSkipped(reason?: string): boolean {
  return reason === "missing_credentials" ||
    (typeof reason === "string" && reason.endsWith("not_configured"));
}

// Provider chain: Yoola (primary) → Africa's Talking (fallback). Tried one at a
// time — AT only fires if Yoola is unconfigured or did not accept the message.
// Every attempt is timestamped so the delivery log proves there is never a
// simultaneous double-send.
async function sendSMS(phone: string, message: string): Promise<SmsOutcome> {
  const attempts: ProviderAttempt[] = [];
  const run = async (provider: string, fn: () => Promise<{ ok: boolean; reason?: string }>) => {
    const started_at = new Date().toISOString();
    const r = await fn();
    const finished_at = new Date().toISOString();
    attempts.push({ provider, accepted: r.ok, reason: r.reason, started_at, finished_at, attempted: !wasSkipped(r.reason) });
    return r;
  };
  const yoola = await run("yoola", () => sendViaYoola(phone, message));
  if (yoola.ok) return { ok: true, provider: "yoola", attempts };
  console.warn("[send-signup-invite-sms] Yoola not accepted; trying Africa's Talking");
  const at = await run("africastalking", () => sendViaAfricasTalking(phone, message));
  if (at.ok) return { ok: true, provider: "africastalking", attempts };
  const reason = (yoola.reason && yoola.reason !== "yoola_not_configured") ? yoola.reason : at.reason;
  return { ok: false, reason, attempts };
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
      reference_id: ctx.referenceId ?? null,
      source: ctx.source,
      provider_response: {
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
    console.warn("[send-signup-invite-sms] sms_delivery_log insert failed (non-critical):", e);
  }
}

function buildMessage(role: InviteRole, fullName: string, link: string): string {
  const first = (fullName || "").trim().split(/\s+/)[0] || "there";
  if (role === "landlord") {
    return `Hi ${first}, you've been added as a landlord on Welile. Create your free account to track rent payouts: ${link}`;
  }
  return `Hi ${first}, you've been added on Welile. Create your free account to track your rent: ${link}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user: caller }, error: authErr } = await adminClient.auth.getUser(token);
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const origin = typeof body?.origin === "string" && body.origin.startsWith("http")
      ? body.origin.replace(/\/+$/, "")
      : "https://welileapp.com";
    const recipientsIn = Array.isArray(body?.recipients) ? body.recipients : [];

    const results: Array<{ role: string; phone: string; outcome: string }> = [];

    for (const r of recipientsIn) {
      const role: InviteRole | null = VALID_ROLES.includes(r?.role) ? r.role : null;
      const fullName = typeof r?.full_name === "string" ? r.full_name.trim() : "";
      const phone = typeof r?.phone === "string" ? r.phone.trim() : "";
      const providedToken = typeof r?.activation_token === "string" ? r.activation_token : null;
      const l9 = last9(phone);

      if (!role || !l9) {
        results.push({ role: String(r?.role ?? "?"), phone, outcome: "invalid" });
        continue;
      }

      // 1) Already a Welile user? Skip — they can just sign in.
      const { data: existingProfile } = await adminClient
        .from("profiles")
        .select("id")
        .like("phone", `%${l9}`)
        .limit(1)
        .maybeSingle();

      if (existingProfile) {
        results.push({ role, phone, outcome: "existing_user" });
        continue;
      }

      // 2) Resolve an activation token to point the invite link at.
      let activationToken = providedToken;

      if (!activationToken) {
        // Reuse a pending invite if one already exists for this phone.
        const { data: pending } = await adminClient
          .from("supporter_invites")
          .select("activation_token")
          .eq("status", "pending")
          .like("phone", `%${l9}`)
          .limit(1)
          .maybeSingle();

        if (pending?.activation_token) {
          activationToken = pending.activation_token as string;
        } else {
          // Create a fresh invite (landlord path — no auth user yet).
          const cleanPhone = phone.replace(/\s/g, "");
          const virtualEmail = `${toDigits(phone)}@welile.user`;
          const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";
          const { data: invite, error: inviteErr } = await adminClient
            .from("supporter_invites")
            .insert({
              full_name: fullName || `User ${l9.slice(-4)}`,
              phone: cleanPhone,
              email: virtualEmail,
              temp_password: tempPassword,
              role,
              created_by: caller.id,
              status: "pending",
            })
            .select("activation_token")
            .single();

          if (inviteErr || !invite?.activation_token) {
            console.error("[send-signup-invite-sms] invite insert failed:", inviteErr?.message);
            results.push({ role, phone, outcome: "invite_failed" });
            continue;
          }
          activationToken = invite.activation_token as string;
        }
      }

      const link = `${origin}/join?t=${activationToken}`;
      const message = buildMessage(role, fullName, link);
      const sent = await sendSMS(phone, message);
      await logSmsAttempts(adminClient, {
        phone,
        message,
        name: fullName ?? null,
        referenceId: activationToken ?? null,
        source: "send-signup-invite-sms",
      }, sent);
      results.push({ role, phone, outcome: sent.ok ? "sms_sent" : "sms_failed" });
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[send-signup-invite-sms] Unhandled error:", error?.message || error);
    return new Response(JSON.stringify({ error: error?.message || "Service error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});