// Withdrawal PIN: changing or resetting it needs a code sent to the account's real email (doc 258, CTO 2026-11-04).
//
// Why an edge function: sending an email, and deciding whether an address is a real inbox (59% of accounts carry a
// placeholder one), both live outside the database. The database functions (pin_reset_begin, pin_challenge_issue,
// pin_reset_complete, pin_change_issue, pin_change_complete) are service-role only and trust what this function tells them.
//
// Forgot PIN (no PIN needed):
//   begin      start a reset (refused with no_email when the account has no real email)
//   send_code  email a 6-digit code (10 min, 3 per hour)
//   complete   check the code and set the new PIN
// Change PIN (current PIN + code):
//   change_send_code  email a 6-digit code
//   change_complete   check the current PIN AND the code, then set the new PIN
//
// No SMS is involved. An account without a real email can neither change nor reset a PIN: it must add one first.
// Codes are generated here, only their sha256 is stored, and neither a code nor a PIN is ever logged.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isUnusableEmail, maskEmail } from "../_shared/twoFactorEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Uniform 6 digits (rejection sampling, no modulo bias), from the secure generator.
function generateCode(): string {
  const LIMIT = Math.floor(0x100000000 / 1000000) * 1000000;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= LIMIT);
  return String(buf[0] % 1000000).padStart(6, "0");
}

// sha256 hex of "<user id>:email:<code>".
async function hashCode(userId: string, code: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}:email:${code}`));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PIN_RE = /^\d{4}$/;
const CODE_RE = /^\d{6}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const userId = u.user.id;

    const body = (await req.json().catch(() => ({}))) ?? {};
    const action = String(body.action ?? "");

    // The real inbox, if any: the sign-in address first (the one the account proved), then the profile address.
    const { data: profile } = await admin
      .from("profiles")
      .select("email, full_name")
      .eq("id", userId)
      .maybeSingle();
    const candidates = [u.user.email, profile?.email as string | null | undefined];
    const realEmail = candidates.find((e) => e && !isUnusableEmail(e)) ?? null;

    // Emails a fresh code. Returns null on success, or the response to send back.
    async function emailCode(issue: (hash: string, masked: string) => Promise<any>, label: string) {
      if (!realEmail) return json({ success: false, code: "no_email" }, 400);
      const code = generateCode();
      const masked = maskEmail(realEmail);
      const issued = await issue(await hashCode(userId, code), masked);
      if (issued.error) {
        console.error("[withdrawal-pin-reset] issue failed", issued.error.message);
        return json({ error: "Could not create the code" }, 500);
      }
      const data = issued.data;
      if (data?.success !== true) return json(data, data?.code === "rate_limited" ? 429 : 400);

      const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "two-factor-code",
          recipientEmail: realEmail.toLowerCase(),
          templateData: {
            code,
            userName: (profile?.full_name as string | null)?.split(" ")[0] || "there",
            deviceLabel: label,
            requestedAt: new Date().toISOString(),
            minutesValid: data.expires_in_minutes,
          },
        },
      });
      if (mailErr) {
        console.error("[withdrawal-pin-reset] email failed", mailErr);
        return json({ error: "Could not send the code. Please try again.", code: "send_failed" }, 502);
      }
      return json({ success: true, channel: "email", destination_masked: masked, expires_in_minutes: data.expires_in_minutes });
    }

    if (action === "begin") {
      const { data, error } = await admin.rpc("pin_reset_begin", { p_user: userId, p_email_usable: realEmail !== null });
      if (error) {
        console.error("[withdrawal-pin-reset] begin failed", error.message);
        return json({ error: "Could not start the reset" }, 500);
      }
      if (data?.success !== true) return json(data, 400);
      return json({ ...data, email_masked: realEmail ? maskEmail(realEmail) : null });
    }

    if (action === "send_code") {
      if (String(body.channel ?? "email") !== "email") return json({ success: false, code: "channel_not_required" }, 400);
      return await emailCode(
        (hash, masked) => admin.rpc("pin_challenge_issue", { p_user: userId, p_channel: "email", p_code_hash: hash, p_destination_masked: masked }),
        "Withdrawal PIN reset",
      );
    }

    if (action === "complete") {
      const emailCodeIn = String(body.email_code ?? "");
      const newPin = String(body.new_pin ?? "");
      if (!CODE_RE.test(emailCodeIn)) return json({ success: false, code: "wrong_code", channel: "email" }, 400);
      const { data, error } = await admin.rpc("pin_reset_complete", {
        p_user: userId,
        p_sms_code_hash: null,
        p_email_code_hash: await hashCode(userId, emailCodeIn),
        p_new_pin: newPin,
      });
      if (error) {
        console.error("[withdrawal-pin-reset] complete failed", error.message);
        return json({ error: "Could not finish the reset" }, 500);
      }
      return json(data, data?.success === true ? 200 : 400);
    }

    if (action === "change_send_code") {
      return await emailCode(
        (hash, masked) => admin.rpc("pin_change_issue", { p_user: userId, p_code_hash: hash, p_destination_masked: masked }),
        "Withdrawal PIN change",
      );
    }

    if (action === "change_complete") {
      const currentPin = String(body.current_pin ?? "");
      const emailCodeIn = String(body.email_code ?? "");
      const newPin = String(body.new_pin ?? "");
      // Malformed input is refused without touching the attempt counters.
      if (!PIN_RE.test(currentPin)) return json({ success: false, code: "wrong_pin", message: "Enter your 4-digit PIN." }, 400);
      if (!CODE_RE.test(emailCodeIn)) return json({ success: false, code: "wrong_code", channel: "email" }, 400);
      const { data, error } = await admin.rpc("pin_change_complete", {
        p_user: userId,
        p_current_pin: currentPin,
        p_email_code_hash: await hashCode(userId, emailCodeIn),
        p_new_pin: newPin,
      });
      if (error) {
        console.error("[withdrawal-pin-reset] change failed", error.message);
        return json({ error: "Could not change the PIN" }, 500);
      }
      return json(data, data?.success === true ? 200 : 400);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[withdrawal-pin-reset] error", e instanceof Error ? e.message : e);
    return json({ error: "Internal error" }, 500);
  }
});
