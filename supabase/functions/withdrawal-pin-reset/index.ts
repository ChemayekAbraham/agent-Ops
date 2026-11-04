// Forgotten withdrawal PIN: the 2FA reset (doc 258).
//
// Why an edge function: sending an email or an SMS, and deciding whether an address is a real inbox
// (59% of accounts carry a placeholder one), both live outside the database. The database functions
// (pin_reset_begin / pin_challenge_issue / pin_reset_complete) are service-role only and trust what this
// function tells them.
//
//   begin      start a reset; tells the owner by SMS (the cancel path is the PIN screen or support)
//   send_code  send a 6-digit code to the email or to the login / payout number (10 min, 3 per hour)
//   complete   check the code(s) and set the new PIN
//
// Real inbox on file: an email code AND a phone code are both required. No usable email: the phone code
// alone, after the 48 h cooling-off wait the database enforces. Codes are generated here, only their
// hash is stored, and neither a code nor a PIN is ever logged.
import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isUnusableEmail, maskEmail } from "../_shared/twoFactorEmail.ts";
import { isUgandanPhone, sendSMS } from "../_shared/sendSmsMultiProvider.ts";

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

// Must match what the browser-side caller sends: sha256 hex of "<user id>:<channel>:<code>".
async function hashCode(userId: string, channel: "sms" | "email", code: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}:${channel}:${code}`));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length < 6 ? "•••••" : `+••• ••• ${digits.slice(-3)}`;
}

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

    // The real inbox, if any: the sign-in address, else the profile address.
    const { data: profile } = await admin
      .from("profiles")
      .select("phone, mobile_money_number, email, full_name")
      .eq("id", userId)
      .maybeSingle();
    const candidates = [u.user.email, profile?.email as string | null | undefined];
    const realEmail = candidates.find((e) => e && !isUnusableEmail(e)) ?? null;
    const loginPhone = String(profile?.phone ?? "").trim();
    const payoutPhone = String(profile?.mobile_money_number ?? "").trim();

    if (action === "begin") {
      const { data, error } = await admin.rpc("pin_reset_begin", {
        p_user: userId,
        p_email_usable: realEmail !== null,
      });
      if (error) {
        console.error("[withdrawal-pin-reset] begin failed", error.message);
        return json({ error: "Could not start the reset" }, 500);
      }
      if (data?.success !== true) return json(data, 400);

      // Tell the owner on the login number. Best effort: the reset is already recorded.
      if (data.code === "reset_requested" && isUgandanPhone(loginPhone)) {
        await sendSMS(
          loginPhone,
          "Welile: a reset of your withdrawal PIN was requested. If this was not you, cancel it in Settings > Withdrawal PIN or contact support.",
          { admin, source: "withdrawal_pin_reset_notice", recipient_user_id: userId },
        ).catch((e) => console.error("[withdrawal-pin-reset] notice sms failed", e));
      }
      return json({
        ...data,
        email_masked: realEmail ? maskEmail(realEmail) : null,
        phone_masked: isUgandanPhone(loginPhone) ? maskPhone(loginPhone) : null,
        payout_phone_masked: isUgandanPhone(payoutPhone) ? maskPhone(payoutPhone) : null,
      });
    }

    if (action === "send_code") {
      const channel = String(body.channel ?? "");
      if (channel !== "email" && channel !== "sms") return json({ error: "Invalid channel" }, 400);

      let destination: string;
      let masked: string;
      if (channel === "email") {
        if (!realEmail) return json({ error: "No usable email on this account", code: "no_email" }, 400);
        destination = realEmail.toLowerCase();
        masked = maskEmail(realEmail);
      } else {
        // The login number by default; the payout number if the login number is lost.
        const target = String(body.sms_target ?? "login");
        const phone = target === "payout" ? payoutPhone : loginPhone;
        if (!isUgandanPhone(phone)) return json({ error: "No usable phone number for that choice", code: "no_phone" }, 400);
        destination = phone;
        masked = maskPhone(phone);
      }

      const code = generateCode();
      const { data: issued, error: issueErr } = await admin.rpc("pin_challenge_issue", {
        p_user: userId,
        p_channel: channel,
        p_code_hash: await hashCode(userId, channel, code),
        p_destination_masked: masked,
      });
      if (issueErr) {
        console.error("[withdrawal-pin-reset] issue failed", issueErr.message);
        return json({ error: "Could not create the code" }, 500);
      }
      if (issued?.success !== true) return json(issued, issued?.code === "rate_limited" ? 429 : 400);

      let sent = false;
      if (channel === "email") {
        const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
          body: {
            templateName: "two-factor-code",
            recipientEmail: destination,
            templateData: {
              code,
              userName: (profile?.full_name as string | null)?.split(" ")[0] || "there",
              deviceLabel: "Withdrawal PIN reset",
              requestedAt: new Date().toISOString(),
              minutesValid: issued.expires_in_minutes,
            },
          },
        });
        sent = !mailErr;
        if (mailErr) console.error("[withdrawal-pin-reset] email failed", mailErr);
      } else {
        sent = await sendSMS(
          destination,
          `Welile PIN reset code: ${code}. Valid ${issued.expires_in_minutes} min. Do not share it.`,
          {
            admin,
            source: "withdrawal_pin_reset",
            reference_id: issued.challenge_id,
            recipient_user_id: userId,
            requireDeliveryConfirmation: true,
            deliveryConfirmation: { attempts: 2, delayMs: 1500 },
          },
        );
      }
      if (!sent) return json({ error: "Could not send the code. Please try again.", code: "send_failed" }, 502);
      return json({ success: true, channel, destination_masked: masked, expires_in_minutes: issued.expires_in_minutes });
    }

    if (action === "complete") {
      const smsCode = String(body.sms_code ?? "");
      const emailCode = body.email_code == null ? null : String(body.email_code);
      const newPin = String(body.new_pin ?? "");
      if (!/^\d{6}$/.test(smsCode) || (emailCode !== null && !/^\d{6}$/.test(emailCode))) {
        return json({ error: "Codes are 6 digits" }, 400);
      }
      const { data, error } = await admin.rpc("pin_reset_complete", {
        p_user: userId,
        p_sms_code_hash: await hashCode(userId, "sms", smsCode),
        p_email_code_hash: emailCode === null ? null : await hashCode(userId, "email", emailCode),
        p_new_pin: newPin,
      });
      if (error) {
        console.error("[withdrawal-pin-reset] complete failed", error.message);
        return json({ error: "Could not finish the reset" }, 500);
      }
      return json(data, data?.success === true ? 200 : 400);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[withdrawal-pin-reset] error", e instanceof Error ? e.message : e);
    return json({ error: "Internal error" }, 500);
  }
});
