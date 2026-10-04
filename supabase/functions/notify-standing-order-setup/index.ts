import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

// Marker error so the retry loop knows the failure is transient and worth retrying.
class TransientError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with exponential backoff + jitter. Only TransientError (and the
 * generic throws from network failures) trigger a retry; a thrown non-transient
 * error or a falsy return stops immediately. Returns the last value.
 */
async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  opts: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onAttempt?: (info: {
      attempt: number;
      outcome: "success" | "transient_failure" | "permanent_failure";
      error: string | null;
    }) => Promise<void> | void;
  } = {},
): Promise<{ value: T | null; attempts: number; ok: boolean; lastError: string | null }> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const onAttempt = opts.onAttempt;
  let attempt = 0;
  let lastValue: T | null = null;
  let lastError: string | null = null;
  while (attempt <= retries) {
    attempt++;
    try {
      lastValue = await fn(attempt);
      // A falsy return is a permanent rejection (e.g. bad number), not success.
      const ok = !!lastValue;
      await onAttempt?.({
        attempt,
        outcome: ok ? "success" : "permanent_failure",
        error: ok ? null : `${label} rejected (no retry)`,
      });
      return { value: lastValue, attempts: attempt, ok: true, lastError: null };
    } catch (err) {
      const transient = err instanceof TransientError;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `[notify-standing-order-setup] ${label} attempt ${attempt} failed (transient=${transient}):`,
        err instanceof Error ? err.message : err,
      );
      const willRetry = transient && attempt <= retries;
      await onAttempt?.({
        attempt,
        outcome: willRetry ? "transient_failure" : "permanent_failure",
        error: lastError,
      });
      if (!transient || attempt > retries) {
        return { value: lastValue, attempts: attempt, ok: false, lastError };
      }
      // Exponential backoff with full jitter.
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * backoff);
      await sleep(delay);
    }
  }
  return { value: lastValue, attempts: attempt, ok: false, lastError };
}

async function sendSMSOnce(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "notify-standing-order-setup" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    // Misconfiguration is permanent — do not retry.
    console.error("[notify-standing-order-setup] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const body = new URLSearchParams({
    username, from: "WELILE",
    to: formatPhoneInternational(phone),    message,
  });

  let res: Response;
  try {
    res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    // Network-level failure → transient.
    throw new TransientError(`SMS network error: ${err instanceof Error ? err.message : err}`);
  }

  // 5xx and 429 from the gateway are transient; other non-2xx are permanent.
  if (res.status >= 500 || res.status === 429) {
    await res.text().catch(() => undefined);
    throw new TransientError(`SMS gateway HTTP ${res.status}`);
  }

  const raw = await res.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { return false; }
  const recipients = data?.SMSMessageData?.Recipients || [];
  // statusCode 101/100 = success/queued; 5xx-style telecom codes are transient.
  if (recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100)) return true;
  const transientTelecom = recipients.some((r: any) => [407, 409, 500, 501].includes(r.statusCode));
  if (transientTelecom || recipients.length === 0) {
    throw new TransientError(`SMS not accepted: ${raw.slice(0, 180)}`);
  }
  // Permanent recipient rejection (bad number, blacklisted, etc.).
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      target_user_id,
      scheduled_payout_id,
      amount,
      schedule,
      reason,
      next_run_at,
      channel: requestedChannel,
    } = await req.json();

    if (!target_user_id || amount == null) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // When a single channel is requested (manual resend), only that channel runs.
    // Omitting `channel` (initial setup) sends both SMS and email.
    const doSms = !requestedChannel || requestedChannel === "sms";
    const doEmail = !requestedChannel || requestedChannel === "email";

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Persist per-channel delivery status so staff can see what was delivered.
    const recordStatus = async (
      channel: "sms" | "email",
      fields: {
        status: "pending" | "sent" | "failed" | "skipped";
        attempts?: number;
        last_error?: string | null;
        last_sent_at?: string | null;
        recipient?: string | null;
      },
    ) => {
      try {
        await adminClient
          .from("standing_order_setup_notifications")
          .upsert(
            {
              scheduled_payout_id: scheduled_payout_id ?? null,
              target_user_id,
              channel,
              status: fields.status,
              attempts: fields.attempts ?? 0,
              last_error: fields.last_error ?? null,
              last_sent_at: fields.last_sent_at ?? null,
              recipient: fields.recipient ?? null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "scheduled_payout_id,channel" },
          );
      } catch (e) {
        console.error(`[notify-standing-order-setup] failed to record ${channel} status:`, e);
      }
    };

    // Append one row per individual delivery attempt so staff can see a full
    // retry timeline (each attempt's time, outcome, and error).
    const recordAttempt = async (
      channel: "sms" | "email",
      info: {
        attempt_number: number;
        outcome: "success" | "transient_failure" | "permanent_failure" | "skipped";
        error?: string | null;
        recipient?: string | null;
      },
    ) => {
      try {
        await adminClient.from("standing_order_notification_attempts").insert({
          scheduled_payout_id: scheduled_payout_id ?? null,
          target_user_id,
          channel,
          attempt_number: info.attempt_number,
          outcome: info.outcome,
          error: info.error ?? null,
          recipient: info.recipient ?? null,
          attempted_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error(`[notify-standing-order-setup] failed to record ${channel} attempt:`, e);
      }
    };

    const { data: profile } = await adminClient
      .from("profiles")
      .select("full_name, phone, email")
      .eq("id", target_user_id)
      .maybeSingle();

    if (!profile) {
      return new Response(JSON.stringify({ error: "Recipient not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const firstName = (profile.full_name || "there").split(" ")[0];
    const amountStr = `UGX ${Number(amount).toLocaleString()}`;
    const scheduleLabel = schedule || "on a recurring basis";
    let nextRunLabel = "";
    if (next_run_at) {
      try {
        nextRunLabel = new Date(next_run_at).toLocaleString("en-GB", {
          day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
        });
      } catch { /* ignore */ }
    }

    // 1) SMS to the recipient confirming the standing order is set.
    let smsSent = false;
    if (doSms && profile.phone) {
      const msg = `Hi ${firstName}, WELILE has set up an automatic payout of ${amountStr} to your wallet (${scheduleLabel}). You'll get a message each time it runs. welileapp.com`;
      const smsResult = await withRetry(
        "sms",
        () => sendSMSOnce(profile.phone!, msg),
        {
          retries: 3,
          baseDelayMs: 500,
          onAttempt: (info) =>
            recordAttempt("sms", {
              attempt_number: info.attempt,
              outcome: info.outcome,
              error: info.error,
              recipient: profile.phone,
            }),
        },
      );
      smsSent = smsResult.ok && smsResult.value === true;
      await recordStatus("sms", {
        status: smsSent ? "sent" : "failed",
        attempts: smsResult.attempts,
        last_error: smsSent ? null : (smsResult.lastError ?? "SMS not accepted by gateway"),
        last_sent_at: smsSent ? new Date().toISOString() : null,
        recipient: profile.phone,
      });
    } else if (doSms) {
      await recordStatus("sms", { status: "skipped", last_error: "No phone number on profile" });
      await recordAttempt("sms", {
        attempt_number: 1,
        outcome: "skipped",
        error: "No phone number on profile",
      });
    }

    // 2) Email to the recipient (skip synthetic @welile.user addresses).
    let emailSent = false;
    if (doEmail && profile.email && !profile.email.endsWith("@welile.user")) {
      // The same idempotencyKey across retries means the email pipeline de-dupes
      // if an earlier attempt actually succeeded before the error surfaced.
      const emailResult = await withRetry(
        "email",
        async () => {
          const { error: emailErr } = await adminClient.functions.invoke("send-transactional-email", {
            body: {
              templateName: "standing-order-created",
              recipientEmail: profile.email,
              idempotencyKey: `standing-order-created-${scheduled_payout_id ?? target_user_id}`,
              templateData: {
                recipient_name: profile.full_name || "there",
                amount: Number(amount),
                currency: "UGX",
                schedule: scheduleLabel,
                reason: reason || "",
                next_run: nextRunLabel,
              },
            },
          });
          if (emailErr) {
            // Edge invoke errors are network/5xx in practice → treat as transient.
            throw new TransientError(emailErr.message ?? "email invoke error");
          }
          return true;
        },
        {
          retries: 3,
          baseDelayMs: 500,
          onAttempt: (info) =>
            recordAttempt("email", {
              attempt_number: info.attempt,
              outcome: info.outcome,
              error: info.error,
              recipient: profile.email,
            }),
        },
      );
      emailSent = emailResult.ok && emailResult.value === true;
      await recordStatus("email", {
        status: emailSent ? "sent" : "failed",
        attempts: emailResult.attempts,
        last_error: emailSent ? null : (emailResult.lastError ?? "Email enqueue failed"),
        last_sent_at: emailSent ? new Date().toISOString() : null,
        recipient: profile.email,
      });
    } else if (doEmail) {
      await recordStatus("email", {
        status: "skipped",
        last_error: profile.email ? "Synthetic @welile.user address" : "No email on profile",
        recipient: profile.email ?? null,
      });
      await recordAttempt("email", {
        attempt_number: 1,
        outcome: "skipped",
        error: profile.email ? "Synthetic @welile.user address" : "No email on profile",
        recipient: profile.email ?? null,
      });
    }

    return new Response(JSON.stringify({ success: true, sms_sent: smsSent, email_sent: emailSent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-standing-order-setup] Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
