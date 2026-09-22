import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
// Issue OTP for agent-initiated landlord rent payout.
// Validates float, creates an OTP challenge, sends SMS to landlord.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { confirmYoolaDelivery, extractYoolaMessageId } from "../_shared/yoolaDeliveryConfirm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OTP_TTL_SECONDS = 3600;

function generateOtp(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizePhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  if (!d.startsWith("256") && d.length === 9) d = "256" + d;
  return "+" + d;
}

interface SmsResult {
  ok: boolean;
  statusCode?: number;
  status?: string;
  reason?: string;
  messageId?: string;
  cost?: string;
  raw?: unknown;
  provider?: string;
  fallbackUsed?: boolean;
  primaryProvider?: string;
  primaryReason?: string;
  /** Ordered, timestamped trail of every provider attempt for this send. */
  attempts?: ProviderAttempt[];
}

interface ProviderAttempt {
  provider: string;
  accepted: boolean;
  reason?: string;
  messageId?: string;
  cost?: string;
  raw?: unknown;
  started_at: string;
  finished_at: string;
}

// Yoola is the PRIMARY OTP sender. JSON body { phone, message, api_key } posted
// to https://yoolasms.com/api/v1/send; { status: "success" } = accepted. Phone
// must be country-code digits WITHOUT a leading "+".
async function sendYoolaSms(phone: string, message: string): Promise<SmsResult> {
  const apiKey = (Deno.env.get("YOOLA_SMS_API_KEY") || "").trim();
  if (!apiKey) {
    return { ok: false, reason: "Yoola not configured", provider: "yoola" };
  }
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: phone.replace(/\D/g, ""), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    const status = String(data?.status ?? "").toLowerCase();
    const accepted = res.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued");
    return {
      ok: accepted,
      status: data?.status ?? undefined,
      reason: accepted ? undefined : (data?.message || `Yoola HTTP ${res.status}`),
      messageId: data?.message_id ?? undefined,
      raw: data ?? text,
      provider: "yoola",
    };
  } catch (e) {
    console.error("[issue-landlord-payout-otp] Yoola error:", e);
    return { ok: false, reason: e instanceof Error ? e.message : "Yoola network error", provider: "yoola" };
  }
}

// Africa's Talking returns HTTP 201 even when a recipient is REJECTED (invalid
// number, blacklisted/DND, no credit, unsupported sender id). The real outcome
// lives in SMSMessageData.Recipients[].statusCode (100/101 = accepted). Checking
// only res.ok produced false "sms_sent: true" while the landlord got nothing.
async function sendSms(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.warn("[issue-landlord-payout-otp] Missing Africa's Talking creds — skipping SMS");
    return { ok: false, reason: "Missing Africa's Talking credentials", provider: "africastalking" };
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const params = new URLSearchParams({ username, from: "WELILE", to: phone, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    if (!res.ok) {
      return { ok: false, reason: `AT HTTP ${res.status}: ${text.slice(0, 200)}`, raw: data ?? text, provider: "africastalking" };
    }
    const recipient = data?.SMSMessageData?.Recipients?.[0];
    if (!recipient) {
      // No recipient accepted at all — AT explains why in the Message field.
      return {
        ok: false,
        reason: data?.SMSMessageData?.Message || "No recipient accepted by Africa's Talking",
        raw: data ?? text,
        provider: "africastalking",
      };
    }
    const ok = recipient.statusCode === 100 || recipient.statusCode === 101;
    return {
      ok,
      statusCode: recipient.statusCode,
      status: recipient.status,
      reason: ok ? undefined : `${recipient.status ?? "Rejected"} (code ${recipient.statusCode})`,
      messageId: recipient.messageId ?? undefined,
      cost: recipient.cost ?? undefined,
      raw: data ?? text,
      provider: "africastalking",
    };
  } catch (e) {
    console.error("[issue-landlord-payout-otp] SMS error:", e);
    return { ok: false, reason: e instanceof Error ? e.message : "SMS network error", provider: "africastalking" };
  }
}

// Twilio fallback sender. Routed through the Lovable connector gateway, which
// injects Twilio auth + the Account SID prefix, so we only POST /Messages.json.
// Twilio returns a JSON body with sid (our message id) and status; queued/
// accepted/sending/sent are accepted-by-gateway states. error_code/error_message
// describe rejections (invalid number, unsupported sender id, etc.).
const TWILIO_GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";
const TWILIO_SENDER = "WELILE";
async function sendTwilioSms(phone: string, message: string): Promise<SmsResult> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const twilioKey = Deno.env.get("TWILIO_API_KEY");
  if (!lovableKey || !twilioKey) {
    return { ok: false, reason: "Twilio fallback not configured", provider: "twilio" };
  }
  try {
    const res = await fetch(`${TWILIO_GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": twilioKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: TWILIO_SENDER, Body: message }).toString(),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    if (!res.ok) {
      const reason = data?.error_message || data?.message || `Twilio HTTP ${res.status}: ${text.slice(0, 200)}`;
      return { ok: false, reason, raw: data ?? text, provider: "twilio" };
    }
    const status = (data?.status ?? "").toString().toLowerCase();
    const accepted = ["queued", "accepted", "sending", "sent", "delivered"].includes(status);
    return {
      ok: accepted,
      status: data?.status ?? undefined,
      reason: accepted ? undefined : (data?.error_message || `Twilio status ${data?.status ?? "unknown"}`),
      messageId: data?.sid ?? undefined,
      raw: data ?? text,
      provider: "twilio",
    };
  } catch (e) {
    console.error("[issue-landlord-payout-otp] Twilio error:", e);
    return { ok: false, reason: e instanceof Error ? e.message : "Twilio network error", provider: "twilio" };
  }
}

// Yoola is PRIMARY. If Yoola is not accepted, fall back to Africa's Talking, then
// Twilio — reissuing the same OTP. The returned result reflects whichever
// provider ultimately delivered, with fallback metadata preserved for the audit
// trail.
async function sendOtpWithFallback(phone: string, message: string): Promise<SmsResult> {
  const attempts: ProviderAttempt[] = [];
  const run = async (provider: string, fn: () => Promise<SmsResult>): Promise<SmsResult> => {
    const started_at = new Date().toISOString();
    const r = await fn();
    const finished_at = new Date().toISOString();
    attempts.push({
      provider,
      accepted: r.ok,
      reason: r.reason,
      messageId: r.messageId,
      cost: r.cost,
      raw: r.raw,
      started_at,
      finished_at,
    });
    return r;
  };

  let primary = await run("yoola", () => sendYoolaSms(phone, message));
  if (primary.ok) {
    // Yoola accepting the HTTP request is NOT proof the landlord's handset got
    // the OTP — the carrier can silently drop it. This code gates real money
    // moving out of the Landlord Payout Float, so hold the send open and poll
    // Yoola's delivery report before trusting it, exactly like the cash-deposit
    // code flow (see _shared/yoolaDeliveryConfirm.ts). If delivery is not
    // confirmed inside the window, treat Yoola as failed and fall over to
    // Africa's Talking instead of leaving the landlord without a code.
    const messageId = extractYoolaMessageId(primary.raw);
    const confirmation = await confirmYoolaDelivery(messageId);
    if (confirmation.outcome === "delivered") {
      return { ...primary, attempts };
    }
    const reason = `Yoola accepted but did not confirm delivery (${confirmation.detail ?? confirmation.outcome})`;
    primary = { ...primary, ok: false, reason };
    attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], accepted: false, reason };
    console.warn(`[issue-landlord-payout-otp] ${reason} — falling back to Africa's Talking`);
  } else {
    console.warn(
      `[issue-landlord-payout-otp] Yoola send failed (${primary.reason ?? "unknown"}) — falling back to Africa's Talking`,
    );
  }
  const at = await run("africastalking", () => sendSms(phone, message));
  if (at.ok) {
    return {
      ...at,
      fallbackUsed: true,
      primaryProvider: primary.provider ?? "yoola",
      primaryReason: primary.reason ?? "Yoola send not accepted",
      attempts,
    };
  }
  console.warn(
    `[issue-landlord-payout-otp] AT send failed (${at.reason ?? "unknown"}) — falling back to Twilio`,
  );
  const fallback = await run("twilio", () => sendTwilioSms(phone, message));
  return {
    ...fallback,
    fallbackUsed: true,
    primaryProvider: primary.provider ?? "yoola",
    primaryReason: primary.reason ?? "Yoola send not accepted",
    attempts,
  };
}

async function logSms(
  admin: ReturnType<typeof createClient>,
  phone: string,
  message: string,
  result: SmsResult,
  recipientName?: string | null,
  referenceId?: string | null,
) {
  try {
    // Write one row per provider attempt so the audit trail shows exactly which
    // provider was tried, in what order, and the timestamped outcome — proving
    // providers fired strictly sequentially (never a double-send).
    const attempts = result.attempts && result.attempts.length
      ? result.attempts
      : [{
          provider: result.provider ?? "africastalking",
          accepted: result.ok,
          reason: result.reason,
          messageId: result.messageId,
          cost: result.cost,
          raw: result.raw,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        } as ProviderAttempt];

    const rows = attempts.map((a, i) => ({
      recipient_phone: phone,
      recipient_name: recipientName ?? null,
      message,
      // "sent" = accepted by the gateway (awaiting delivery report). The DLR
      // callback later upgrades this to "delivered" or downgrades to "failed".
      status: a.accepted ? "sent" : "failed",
      provider: a.provider,
      provider_message_id: a.messageId ?? null,
      cost: a.cost ?? null,
      reference_id: referenceId ?? null,
      provider_response: {
        attempt_sequence: i + 1,
        total_attempts: attempts.length,
        started_at: a.started_at,
        finished_at: a.finished_at,
        reason: a.reason ?? null,
        final_provider: result.ok ? result.provider ?? null : null,
        final_accepted: result.ok,
        gateway_response: a.raw ?? null,
      },
      error: a.accepted ? null : (a.reason ?? null),
      source: "issue-landlord-payout-otp",
    }));
    await admin.from("sms_delivery_log").insert(rows);
  } catch (e) {
    console.warn("[issue-landlord-payout-otp] sms_delivery_log insert failed (non-critical):", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const agentId = u.user.id;

    const body = await req.json().catch(() => ({}));
    const {
      landlord_id,
      landlord_name,
      // landlord_phone deliberately NOT read from the client — see resolvedPhone below.
      tenant_id,
      tenant_name,
      tenant_phone,
      rent_request_id,
      amount,
      mobile_money_provider,
      agent_latitude,
      agent_longitude,
      property_latitude,
      property_longitude,
      challenge_id, // optional: resend OTP for existing challenge
      trigger_source, // optional: 'auto' (auto-sent on withdraw float tap) | 'manual'
    } = body ?? {};

    const normalizedTrigger = trigger_source === "auto" ? "auto" : "manual";

    // Resend path
    if (challenge_id) {
      const { data: existing } = await admin
        .from("landlord_payout_otp_challenges")
        .select("*")
        .eq("id", challenge_id)
        .eq("agent_id", agentId)
        .maybeSingle();
      if (!existing) return json({ error: "Challenge not found" }, 404);
      if (existing.status !== "pending") return json({ error: "Challenge no longer pending" }, 400);

      const otp = generateOtp();
      const otp_hash = await sha256(otp);
      const otp_expires_at = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();
      await admin
        .from("landlord_payout_otp_challenges")
        .update({ otp_hash, otp_expires_at, attempts: 0 })
        .eq("id", challenge_id);

      // Attempt number = how many times this challenge has been sent/resent + 1.
      const { count: priorSends } = await admin
        .from("landlord_payout_otp_events")
        .select("id", { count: "exact", head: true })
        .eq("challenge_id", challenge_id)
        .in("event_type", ["sent", "resent"]);
      const attemptNumber = (priorSends ?? 0) + 1;

      const phone = normalizePhone(existing.landlord_phone);
      const resent = await sendOtpWithFallback(
        phone,
        `Welile: You are receiving UGX ${Number(existing.amount).toLocaleString()} as rent. OTP: ${otp}. Valid 1 hour. Share with the agent ONLY if you want to receive this money.`,
      );
      await logSms(admin, phone, "Landlord payout OTP (resend)", resent, existing.landlord_name ?? null, challenge_id);
      await admin.from("landlord_payout_otp_events").insert({
        challenge_id,
        agent_id: agentId,
        landlord_id: existing.landlord_id,
        event_type: "resent",
        landlord_phone: existing.landlord_phone,
        amount: existing.amount,
        otp_expires_at,
        detail: resent.ok
          ? (resent.fallbackUsed
            ? `OTP resent via Twilio fallback (Africa's Talking failed: ${resent.primaryReason ?? "unknown"})`
            : "OTP resent via SMS")
          : `OTP regenerated (SMS NOT delivered: ${resent.reason ?? "unknown"})`,
        failure_reason: resent.ok ? null : (resent.reason ?? "sms_not_delivered"),
        metadata: {
          attempt_number: attemptNumber,
          sms_sent: resent.ok,
          sms_status: resent.status ?? null,
          sms_status_code: resent.statusCode ?? null,
          sms_reason: resent.reason ?? null,
          sms_message_id: resent.messageId ?? null,
          sms_provider: resent.provider ?? null,
          fallback_used: resent.fallbackUsed ?? false,
          primary_provider: resent.primaryProvider ?? null,
          primary_reason: resent.primaryReason ?? null,
          delivery_status: resent.ok ? "submitted" : "failed",
        },
      });
      return json({ success: true, challenge_id, expires_at: otp_expires_at, attempt_number: attemptNumber, sms_sent: resent.ok, sms_reason: resent.reason ?? null });
    }

    // Validation
    if (!landlord_id || !landlord_name || !amount || !mobile_money_provider) {
      return json({ error: "Missing required fields" }, 400);
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return json({ error: "Invalid amount" }, 400);
    if (!["MTN", "Airtel"].includes(mobile_money_provider)) {
      return json({ error: "Invalid provider" }, 400);
    }

    // The landlord's phone is NEVER taken from the client — a caller-supplied
    // number would let anyone retarget the OTP (and the eventual MoMo payout)
    // to a phone they control. Always re-derive from the `landlords` table,
    // the same source of truth the payout UI displays. Fixing a wrong/missing
    // number goes through Landlord Ops (landlord_verification_requests), not
    // this endpoint.
    const { data: landlordRow, error: landlordErr } = await admin
      .from("landlords")
      .select("mobile_money_number, phone")
      .eq("id", landlord_id)
      .maybeSingle();
    if (landlordErr) {
      return json({ error: landlordErr.message }, 400);
    }
    const resolvedPhone = (landlordRow?.mobile_money_number || landlordRow?.phone || "").trim();
    if (!resolvedPhone) {
      return json({ error: "No phone number on file for this landlord. Ask Landlord Ops to add one before this payout can proceed." }, 400);
    }
    if (!/^\+?\d{9,15}$/.test(resolvedPhone.replace(/\s|-/g, ""))) {
      return json({ error: "The landlord's number on file is invalid. Ask Landlord Ops to correct it." }, 400);
    }

    // Eligibility check (float, cutoff, landlord status) — same gate as final insert
    const { data: elig, error: eligErr } = await admin.rpc("check_landlord_payout_eligibility", {
      p_agent_id: agentId,
      p_landlord_id: landlord_id,
      p_amount: amt,
    });
    if (eligErr) return json({ error: eligErr.message }, 400);
    if (elig && (elig as any).eligible === false) {
      const e = elig as any;
      const reasons: string[] = [];
      if (e.float_ok === false) {
        reasons.push(`Insufficient float (have UGX ${Number(e.current_float ?? 0).toLocaleString()}, need UGX ${amt.toLocaleString()})`);
      }
      if (e.cutoff_ok === false) reasons.push("Outside payout cutoff window");
      if (e.landlord_verified === false) reasons.push("Landlord not verified for payouts");
      const reason = reasons.length ? reasons.join("; ") : (e.reason ?? "Not eligible for payout");
      return json({ error: reason, details: e }, 400);
    }

    // Generate OTP and persist challenge
    const otp = generateOtp();
    const otp_hash = await sha256(otp);
    const otp_expires_at = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

    const { data: challenge, error: insErr } = await admin
      .from("landlord_payout_otp_challenges")
      .insert({
        agent_id: agentId,
        landlord_id,
        tenant_id: tenant_id ?? null,
        rent_request_id: rent_request_id ?? null,
        amount: amt,
        landlord_name,
        landlord_phone: resolvedPhone,
        tenant_name: tenant_name ?? null,
        tenant_phone: tenant_phone ?? null,
        mobile_money_provider,
        otp_hash,
        otp_expires_at,
        agent_latitude: agent_latitude ?? null,
        agent_longitude: agent_longitude ?? null,
        property_latitude: property_latitude ?? null,
        property_longitude: property_longitude ?? null,
      })
      .select("id")
      .single();

    if (insErr || !challenge) {
      console.error("[issue-landlord-payout-otp] insert failed", insErr);
      return json({ error: insErr?.message ?? "Could not create challenge" }, 500);
    }

    const phone = normalizePhone(resolvedPhone);
    const sent = await sendOtpWithFallback(
      phone,
      `Welile: You are receiving UGX ${amt.toLocaleString()} as rent${tenant_name ? ` from ${tenant_name}` : ""}. OTP: ${otp}. Valid 1 hour. Share with the agent ONLY if you want to receive this money.`,
    );
    await logSms(admin, phone, "Landlord payout OTP", sent, landlord_name ?? null, challenge.id);

    await admin.from("landlord_payout_otp_events").insert({
      challenge_id: challenge.id,
      agent_id: agentId,
      landlord_id,
      event_type: "sent",
      landlord_phone: resolvedPhone,
      amount: amt,
      otp_expires_at,
      detail: normalizedTrigger === "auto"
        ? (sent.ok
          ? (sent.fallbackUsed
            ? `OTP auto-sent via Twilio fallback on withdraw float tap (Africa's Talking failed: ${sent.primaryReason ?? "unknown"})`
            : "OTP auto-sent via SMS on withdraw float tap")
          : `OTP auto-created on withdraw float tap (SMS NOT delivered: ${sent.reason ?? "unknown"})`)
        : (sent.ok
          ? (sent.fallbackUsed
            ? `OTP sent via Twilio fallback (Africa's Talking failed: ${sent.primaryReason ?? "unknown"})`
            : "OTP sent via SMS")
          : `OTP created (SMS NOT delivered: ${sent.reason ?? "unknown"})`),
      failure_reason: sent.ok ? null : (sent.reason ?? "sms_not_delivered"),
      metadata: {
        attempt_number: 1,
        sms_sent: sent.ok,
        sms_status: sent.status ?? null,
        sms_status_code: sent.statusCode ?? null,
        sms_reason: sent.reason ?? null,
        sms_message_id: sent.messageId ?? null,
        sms_provider: sent.provider ?? null,
        fallback_used: sent.fallbackUsed ?? false,
        primary_provider: sent.primaryProvider ?? null,
        primary_reason: sent.primaryReason ?? null,
        delivery_status: sent.ok ? "submitted" : "failed",
        tenant_name: tenant_name ?? null,
        trigger_source: normalizedTrigger,
      },
    });

    return json({
      success: true,
      challenge_id: challenge.id,
      expires_at: otp_expires_at,
      attempt_number: 1,
      sms_sent: sent.ok,
      sms_reason: sent.reason ?? null,
    });
  } catch (e) {
    console.error("[issue-landlord-payout-otp] error", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }

  function json(b: unknown, status = 200) {
    return new Response(JSON.stringify(b), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});