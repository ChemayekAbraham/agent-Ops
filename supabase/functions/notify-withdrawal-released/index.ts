import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatPhoneInternational, isUgandanPhone } from "./phone.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";
import {
  buildWithdrawalReleasedSms,
  ensureWithdrawalTrackingToken,
  supabaseTrackingTokenStore,
  withdrawalTrackingUrl,
} from "../_shared/withdrawalTracking.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── SMS helper (Africa's Talking) — mirrors notify-withdrawal-claimed ────
interface SmsResult {
  sent: boolean;
  attempts: number;
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendSMSOnce(
  phone: string,
  message: string,
): Promise<{ ok: boolean; retryable: boolean; error: string | null }> {
  if (await attemptYoolaPrimary(phone, message, { source: "notify-withdrawal-released" })) return { ok: true, retryable: false, error: null };
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    return { ok: false, retryable: false, error: "SMS provider not configured" };
  }
  if (!isUgandanPhone(phone)) {
    return { ok: false, retryable: false, error: "Invalid Ugandan phone/MoMo number" };
  }
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
      const retryable = res.status >= 500 || res.status === 429;
      return {
        ok: false,
        retryable,
        error: `Provider HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    const accepted = recipients.some(
      (r: any) => r.statusCode === 101 || r.statusCode === 100,
    );
    if (accepted) return { ok: true, retryable: false, error: null };
    const reason = recipients.map((r: any) => `${r.number}:${r.status}`).join(", ");
    return {
      ok: false,
      retryable: false,
      error: reason ? `Provider rejected (${reason})` : "Provider returned no accepted recipients",
    };
  } catch (err) {
    return { ok: false, retryable: true, error: `Network error: ${(err as Error)?.message || err}` };
  }
}

async function sendSMSWithRetry(
  phone: string,
  message: string,
  maxAttempts = 3,
): Promise<SmsResult> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await sendSMSOnce(phone, message);
    if (r.ok) {
      if (attempt > 1) {
        console.log(`[notify-withdrawal-released] SMS delivered on attempt ${attempt}`);
      }
      return { sent: true, attempts: attempt, error: null };
    }
    lastError = r.error;
    console.warn(
      `[notify-withdrawal-released] SMS attempt ${attempt}/${maxAttempts} failed: ${r.error}`,
    );
    if (!r.retryable || attempt === maxAttempts) {
      return { sent: false, attempts: attempt, error: lastError };
    }
    await sleep(500 * 2 ** (attempt - 1));
  }
  return { sent: false, attempts: maxAttempts, error: lastError };
}

// Resolve the SMS destination for a withdrawal: for mobile-money payouts the
// user expects the SMS on the MoMo number they entered; fall back to their
// profile phone when that is missing/malformed.
function resolveRecipient(
  payoutMethod: string,
  rawMomo: string,
  profilePhone: string,
): { recipient: string; momoValidButFellBack: boolean } {
  const isMobileMoney = ["mobile_money", "mtn_mobile_money", "airtel_money"].includes(
    payoutMethod || "",
  );
  const trimmedMomo = (rawMomo || "").trim();
  const momoValid = isUgandanPhone(trimmedMomo);
  const formattedMomo = formatPhoneInternational(trimmedMomo);
  const profileValid = isUgandanPhone(profilePhone || "");
  const formattedProfile = formatPhoneInternational(profilePhone || "");

  const recipient = isMobileMoney && momoValid
    ? formattedMomo
    : (profileValid ? formattedProfile : (momoValid ? formattedMomo : ""));
  return {
    recipient,
    momoValidButFellBack: isMobileMoney && !!trimmedMomo && !momoValid,
  };
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

    // Caller must be an active merchant (cash-out) agent — only they release claims.
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
    // Accept either a single id or a batch of ids (timeout can release several).
    const ids: string[] = Array.isArray(body?.withdrawal_ids)
      ? body.withdrawal_ids.filter((x: unknown) => typeof x === "string")
      : (typeof body?.withdrawal_id === "string" ? [body.withdrawal_id] : []);
    // reason: "timeout" (claim window elapsed) | "manual" (agent released it).
    const reason: string = body?.reason === "timeout" ? "timeout" : "manual";

    if (ids.length === 0) {
      return new Response(JSON.stringify({ error: "withdrawal_id(s) required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: rows, error: wErr } = await admin
      .from("withdrawal_requests")
      .select("id, user_id, amount, payout_method, mobile_money_number")
      .in("id", ids.slice(0, 50));
    if (wErr) {
      return new Response(JSON.stringify({ error: wErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ id: string; sent: boolean; attempts: number; error: string | null; skipped?: boolean }> = [];

    for (const w of rows || []) {
      // ── Idempotency guard ──────────────────────────────────────────────
      // Manual release and the auto-timeout can both fire for the same
      // withdrawal. `withdrawal_release_events` has a UNIQUE(withdrawal_id),
      // so the first path to insert "wins" and proceeds to notify; any later
      // path hits a unique violation (23505) and skips — guaranteeing exactly
      // one release SMS/notification per withdrawal release event.
      const { error: claimErr } = await admin
        .from("withdrawal_release_events")
        .insert({
          withdrawal_id: (w as any).id,
          release_reason: reason,
          triggered_by: user.id,
        });
      if (claimErr) {
        if ((claimErr as any).code === "23505") {
          console.log(
            `[notify-withdrawal-released] Release already notified for withdrawal ${(w as any).id} — skipping duplicate (${reason}).`,
          );
          results.push({ id: (w as any).id, sent: false, attempts: 0, error: null, skipped: true });
          continue;
        }
        // Non-conflict error: log and fall through so we don't silently drop
        // the notification because of a transient DB issue.
        console.warn(
          `[notify-withdrawal-released] Idempotency insert failed for ${(w as any).id}:`,
          claimErr,
        );
      }

      const { data: requester } = await admin
        .from("profiles")
        .select("full_name, phone")
        .eq("id", (w as any).user_id)
        .maybeSingle();

      const amount = Number((w as any).amount) || 0;
      const { recipient, momoValidButFellBack } = resolveRecipient(
        (w as any).payout_method || "",
        (w as any).mobile_money_number || "",
        (requester as any)?.phone || "",
      );
      if (momoValidButFellBack) {
        console.warn(
          `[notify-withdrawal-released] Invalid MoMo number for withdrawal ${(w as any).id}; falling back to profile phone`,
        );
      }

      // Customer-facing SMS: never expose merchant agent identity or role, and
      // never promise when the money arrives — the payout is unpaid and back in
      // the queue. Link = this withdrawal's own tracking URL (was a shared
      // https://welileapp.com/auth for everyone).
      let trackingUrl: string | null = null;
      try {
        const token = await ensureWithdrawalTrackingToken(
          supabaseTrackingTokenStore(admin),
          (w as any).id,
        );
        trackingUrl = token ? withdrawalTrackingUrl(token) : null;
      } catch (e) {
        console.warn(`[notify-withdrawal-released] tracking link unavailable for ${(w as any).id}:`, e);
      }
      const smsMsg = buildWithdrawalReleasedSms(amount, trackingUrl);

      let sent = false;
      let smsAttempts = 0;
      let smsError: string | null = recipient
        ? null
        : "No valid Ugandan phone/MoMo number on file for the withdrawal";
      if (recipient) {
        const result = await sendSMSWithRetry(recipient, smsMsg);
        sent = result.sent;
        smsAttempts = result.attempts;
        smsError = result.error;
        if (!sent) {
          console.error(
            `[notify-withdrawal-released] Release SMS FAILED after ${smsAttempts} attempt(s) ` +
              `for withdrawal ${(w as any).id} → ${recipient}: ${smsError}`,
          );
        }
      }

      // In-app notification — independent of SMS delivery.
      try {
        await admin.from("notifications").insert({
          user_id: (w as any).user_id,
          type: "info",
          title: "Withdrawal returned to queue",
          message: reason === "timeout"
            ? `The merchant agent ran out of time, so your withdrawal of UGX ${amount.toLocaleString()} ` +
              `was returned to the queue. Your funds are still on hold and another agent will pick it up shortly.`
            : `Your withdrawal of UGX ${amount.toLocaleString()} was returned to the queue. Your funds remain ` +
              `on hold and another merchant agent will pick it up shortly.`,
          metadata: {
            kind: "withdrawal_update",
            stage: "released",
            release_reason: reason,
            withdrawal_id: (w as any).id,
            amount,
          },
        });
      } catch (e) {
        console.warn("[notify-withdrawal-released] notification insert failed:", e);
      }

      // Audit trail (same log Financial Ops already watches).
      try {
        await admin.from("withdrawal_notification_log").insert({
          withdrawal_id: (w as any).id,
          recipient_id: (w as any).user_id,
          recipient_email: recipient ?? null,
          amount,
          status: sent ? "sent" : "failed",
          error_message: sent
            ? null
            : `${smsError || "Release SMS failed"}${smsAttempts ? ` (after ${smsAttempts} attempt(s))` : ""}`,
        });
      } catch (e) {
        console.warn("[notify-withdrawal-released] log insert failed:", e);
      }

      results.push({ id: (w as any).id, sent, attempts: smsAttempts, error: smsError });
    }

    return new Response(JSON.stringify({ ok: true, reason, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[notify-withdrawal-released] error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});