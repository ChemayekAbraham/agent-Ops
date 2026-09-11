import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatPhoneInternational, isUgandanPhone } from "./phone.ts";
import {
  logSmsDelivery,
  reserveSmsIdempotency,
  finalizeSmsDelivery,
  type SmsAttemptRecord,
} from "../_shared/smsDeliveryLog.ts";
import {
  buildWithdrawalAssignedSms,
  ensureWithdrawalTrackingToken,
  supabaseTrackingTokenStore,
  withdrawalTrackingUrl,
} from "../_shared/withdrawalTracking.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── SMS helper (Africa's Talking) — mirrors approve-withdrawal ──────────
interface SmsResult {
  sent: boolean;
  attempts: number;
  error: string | null;
  trail: SmsAttemptRecord[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Digits-with-country-code (no leading +) form used by Yoola / LANA.
function toMsisdn(phone: string): string {
  const intl = formatPhoneInternational(phone); // e.g. +2567...
  return intl.replace(/^\+/, "");
}

// ── Yoola (PRIMARY) ── JSON body { phone, message, api_key, sender } ─────
async function sendViaYoola(
  phone: string,
  message: string,
): Promise<{ ok: boolean; error: string | null; response?: unknown } | null> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return null; // not configured → skip to next provider
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
    return ok
      ? { ok: true, error: null, response: data ?? raw?.slice(0, 300) }
      : { ok: false, error: `Yoola rejected (HTTP ${res.status} ${status || "no-status"})`, response: data ?? raw?.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: `Yoola network error: ${(err as Error)?.message || err}`, response: null };
  }
}

// ── Africa's Talking (FALLBACK) ─────────────────────────────────────────
async function sendViaAT(
  phone: string,
  message: string,
): Promise<{ ok: boolean; error: string | null; response?: unknown } | null> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return null; // not configured → skip
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formatPhoneInternational(phone),      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `AT HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`, response: text?.slice(0, 300) || null };
    }
    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    const accepted = recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
    if (accepted) return { ok: true, error: null, response: data };
    const reason = recipients.map((r: any) => `${r.number}:${r.status}`).join(", ");
    return { ok: false, error: reason ? `AT rejected (${reason})` : "AT no accepted recipients", response: data };
  } catch (err) {
    return { ok: false, error: `AT network error: ${(err as Error)?.message || err}`, response: null };
  }
}

// ── LANA (FINAL FALLBACK) ── bare /v1/send, Bearer auth ─────────────────
async function sendViaLana(
  phone: string,
  message: string,
): Promise<{ ok: boolean; error: string | null; response?: unknown } | null> {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return null; // not configured → skip
  try {
    const res = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ phone: toMsisdn(phone), sender_id: "WELILE", message}),
    });
    const raw = await res.text();
    let data: any; try { data = JSON.parse(raw); } catch { data = null; }
    const ok = res.ok && data?.status === true;
    return ok
      ? { ok: true, error: null, response: data ?? raw?.slice(0, 300) }
      : { ok: false, error: `LANA rejected (${data?.message || `HTTP ${res.status}`})`, response: data ?? raw?.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: `LANA network error: ${(err as Error)?.message || err}`, response: null };
  }
}

// Single pass through the provider chain: Yoola → Africa's Talking → LANA.
// Returns ok on the first provider that accepts. `retryable` stays true so the
// outer loop re-runs the whole chain (covers transient network failures).
async function sendSMSOnce(
  phone: string,
  message: string,
): Promise<{ ok: boolean; retryable: boolean; error: string | null; trail: SmsAttemptRecord[] }> {
  if (!isUgandanPhone(phone)) {
    return { ok: false, retryable: false, error: "Invalid Ugandan phone/MoMo number", trail: [] };
  }
  const errors: string[] = [];
  const trail: SmsAttemptRecord[] = [];
  const providerNames: Record<string, string> = {
    sendViaYoola: "yoola",
    sendViaAT: "africastalking",
    sendViaLana: "lana",
  };
  for (const send of [sendViaYoola, sendViaAT, sendViaLana]) {
    const r = await send(phone, message);
    if (r === null) continue; // provider unconfigured
    const providerName = providerNames[send.name] || send.name;
    trail.push({ provider: providerName, ok: r.ok, error: r.error, response: (r as any).response });
    if (r.ok) return { ok: true, retryable: false, error: null, trail };
    if (r.error) errors.push(r.error);
  }
  const combined = errors.length ? errors.join(" | ") : "No SMS provider configured";
  return { ok: false, retryable: true, error: combined, trail };
}

// Send with bounded retries + exponential backoff for transient failures.
async function sendSMSWithRetry(
  phone: string,
  message: string,
  maxAttempts = 3,
): Promise<SmsResult> {
  let lastError: string | null = null;
  const trail: SmsAttemptRecord[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await sendSMSOnce(phone, message);
    for (const t of r.trail) trail.push({ ...t, attempt });
    if (r.ok) {
      if (attempt > 1) {
        console.log(`[notify-withdrawal-claimed] SMS delivered on attempt ${attempt}`);
      }
      return { sent: true, attempts: attempt, error: null, trail };
    }
    lastError = r.error;
    console.warn(
      `[notify-withdrawal-claimed] SMS attempt ${attempt}/${maxAttempts} failed: ${r.error}`,
    );
    if (!r.retryable || attempt === maxAttempts) {
      return { sent: false, attempts: attempt, error: lastError, trail };
    }
    await sleep(500 * 2 ** (attempt - 1)); // 500ms, 1s, 2s …
  }
  return { sent: false, attempts: maxAttempts, error: lastError, trail };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Authenticate caller (must be a logged-in user).
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Caller must be an active merchant (cash-out) agent — only they claim payouts.
    const { data: agentRow } = await admin
      .from("cashout_agents")
      .select("id")
      .eq("agent_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (!agentRow) {
      return new Response(JSON.stringify({ error: "Forbidden: not a merchant agent" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const withdrawalId = typeof body?.withdrawal_id === "string" ? body.withdrawal_id : null;
    if (!withdrawalId) {
      return new Response(JSON.stringify({ error: "withdrawal_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load the withdrawal and confirm it is claimed by THIS agent.
    const { data: w, error: wErr } = await admin
      .from("withdrawal_requests")
      .select("id, user_id, amount, assigned_cashout_agent_id, payout_method, mobile_money_number")
      .eq("id", withdrawalId)
      .maybeSingle();
    if (wErr || !w) {
      return new Response(JSON.stringify({ error: "Withdrawal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (w.assigned_cashout_agent_id !== agentRow.id) {
      return new Response(JSON.stringify({ error: "Withdrawal is not claimed by you" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve requester phone and merchant agent name.
    const [{ data: requester }, { data: merchant }] = await Promise.all([
      admin.from("profiles").select("full_name, phone").eq("id", w.user_id).maybeSingle(),
      admin.from("profiles").select("full_name, phone").eq("id", user.id).maybeSingle(),
    ]);

    const merchantName = (merchant as any)?.full_name?.trim() || "a Welile merchant agent";
    const merchantPhone = formatPhoneInternational((merchant as any)?.phone || "");
    const amount = Number(w.amount) || 0;

    // For mobile-money withdrawals, the SMS must go to the MoMo number the user
    // entered for the payout (the destination they expect to be paid on), not
    // necessarily their account profile phone. Fall back to the profile phone.
    const isMobileMoney = ["mobile_money", "mtn_mobile_money", "airtel_money"].includes(
      (w as any).payout_method || "",
    );

    // Validate + normalize the MoMo number entered for the payout before using it
    // as an SMS destination. A malformed/non-Ugandan MoMo number must not be used;
    // fall back to the requester's profile phone instead.
    const rawMomo = ((w as any).mobile_money_number || "").trim();
    const formattedMomo = formatPhoneInternational(rawMomo);
    const momoValid = isUgandanPhone(rawMomo);
    const profilePhone = formatPhoneInternational((requester as any)?.phone || "");
    const profileValid = isUgandanPhone((requester as any)?.phone || "");

    if (isMobileMoney && rawMomo && !momoValid) {
      console.warn(
        `[notify-withdrawal-claimed] Invalid MoMo number for withdrawal ${w.id}; falling back to profile phone`,
      );
    }

    const smsRecipient = isMobileMoney && momoValid
      ? formattedMomo
      : (profileValid ? profilePhone : (momoValid ? formattedMomo : ""));

    // Customer-facing SMS: an assignment acknowledgement only — a claim is not
    // a payment, so it must not say the money was sent or will arrive shortly.
    // The link is this withdrawal's own stable tracking URL (receipt_token →
    // /r/:token), never a shared placeholder. Never expose merchant identity.
    let trackingUrl: string | null = null;
    try {
      const token = await ensureWithdrawalTrackingToken(supabaseTrackingTokenStore(admin), w.id);
      trackingUrl = token ? withdrawalTrackingUrl(token) : null;
    } catch (e) {
      console.warn(`[notify-withdrawal-claimed] tracking link unavailable for ${w.id}:`, e);
    }
    const smsMsg = buildWithdrawalAssignedSms(amount, trackingUrl);

    let sent = false;
    let smsAttempts = 0;
    let smsTrail: SmsAttemptRecord[] = [];
    let smsError: string | null = smsRecipient
      ? null
      : "No valid Ugandan phone/MoMo number on file for the withdrawal";
    let smsSkipped = false;
    if (smsRecipient) {
      // Idempotency: reserve the claim SMS before sending so a retried claim
      // action can never text the requester twice.
      const reservation = await reserveSmsIdempotency(admin, {
        idempotency_key: `withdrawal_claim:${w.id}`,
        recipient_phone: smsRecipient,
        recipient_user_id: w.user_id,
        recipient_name: (requester as any)?.full_name ?? null,
        message: smsMsg,
        reference_id: w.id,
        source: "withdrawal_claim",
      });

      if (!reservation.proceed) {
        // Already sent (or another send is in flight) → do NOT resend.
        smsSkipped = true;
        sent = reservation.alreadySent;
        smsError = reservation.alreadySent
          ? null
          : "Claim SMS send already in progress (idempotency guard)";
        console.log(
          `[notify-withdrawal-claimed] Claim SMS skipped for withdrawal ${w.id}: ${reservation.reason}`,
        );
      } else {
        const result = await sendSMSWithRetry(smsRecipient, smsMsg);
        sent = result.sent;
        smsAttempts = result.attempts;
        smsError = result.error;
        smsTrail = result.trail;
        if (!sent) {
          console.error(
            `[notify-withdrawal-claimed] Claim SMS FAILED after ${smsAttempts} attempt(s) ` +
              `for withdrawal ${w.id} → ${smsRecipient}: ${smsError}`,
          );
        }

        // Finalize the reserved audit row with the real outcome, or write a
        // fresh audit row if reservation fell back (no logId).
        if (reservation.logId) {
          await finalizeSmsDelivery(admin, reservation.logId, {
            status: sent ? "sent" : "failed",
            attempts: smsTrail,
            retries: smsAttempts > 0 ? smsAttempts - 1 : 0,
            error: sent ? null : smsError,
          });
        } else {
          await logSmsDelivery(admin, {
            recipient_phone: smsRecipient,
            recipient_user_id: w.user_id,
            recipient_name: (requester as any)?.full_name ?? null,
            message: smsMsg,
            status: sent ? "sent" : "failed",
            attempts: smsTrail,
            retries: smsAttempts > 0 ? smsAttempts - 1 : 0,
            reference_id: w.id,
            source: "withdrawal_claim",
            error: sent ? null : smsError,
          });
        }
      }
    } else {
      // No valid destination — record the failed attempt (not idempotency-keyed).
      await logSmsDelivery(admin, {
        recipient_phone: "unknown",
        recipient_user_id: w.user_id,
        recipient_name: (requester as any)?.full_name ?? null,
        message: smsMsg,
        status: "failed",
        attempts: [],
        retries: 0,
        reference_id: w.id,
        source: "withdrawal_claim",
        error: smsError,
      });
    }

    // In-app notification center entry so the requester sees that a named
    // merchant agent is now processing their withdrawal — independent of SMS.
    // Fire-and-forget; never let a notification write fail the claim flow.
    try {
      await admin.from("notifications").insert({
        user_id: w.user_id,
        type: "info",
        title: "Withdrawal assigned for processing",
        message:
          `Your withdrawal of UGX ${amount.toLocaleString()} has been assigned to Welile merchant agent ` +
          `${merchantName}${merchantPhone ? ` (${merchantPhone})` : ""}. You'll be notified again once payment has been sent.`,
        metadata: {
          kind: "withdrawal_update",
          stage: "processing",
          tracking_url: trackingUrl,
          withdrawal_id: w.id,
          amount,
          merchant_agent: merchantName,
          merchant_phone: merchantPhone || null,
        },
      });
    } catch (e) {
      console.warn("[notify-withdrawal-claimed] notification insert failed:", e);
    }

    // Audit trail in the same log Financial Ops already watches.
    try {
      await admin.from("withdrawal_notification_log").insert({
        withdrawal_id: w.id,
        recipient_id: w.user_id,
        recipient_email: smsRecipient ?? null,
        amount,
        status: sent ? "sent" : "failed",
        error_message: sent
          ? null
          : `${smsError || "Claim SMS failed"}${smsAttempts ? ` (after ${smsAttempts} attempt(s))` : ""}`,
      });
    } catch (e) {
      console.warn("[notify-withdrawal-claimed] log insert failed:", e);
    }

    return new Response(JSON.stringify({ ok: true, sent, skipped: smsSkipped, attempts: smsAttempts, error: smsError, merchant: merchantName }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[notify-withdrawal-claimed] error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
