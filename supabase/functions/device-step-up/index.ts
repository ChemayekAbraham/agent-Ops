// Shared-device sign-in step-up.
//
// A device's first two public accounts sign in as normal. The 3rd and later
// account to sign in on the same device must confirm a 6-digit code sent by SMS
// to THAT account's own phone, once per account per device. Fake-account farms
// run many accounts from one phone; this makes each extra account need its own
// SIM. Staff are exempt (they have email 2FA). See migration
// 20261019140000_device_signup_cap_and_login_step_up.sql.
//
//   action: "check"   -> record this sign-in; is a code needed on this device?
//   action: "request" -> text a code to the account's phone
//   action: "verify"  -> check the code and trust this account on this device
//
// Kill switch: the function secret DEVICE_STEP_UP_ENFORCE. Unless it is "true",
// "check" only records and flags the device and never asks for a code. Every
// failure path answers "no code needed": an error here must never lock anyone out
// (TwoFactorGate was switched off on 2026-10-17 for blocking sign-in).

import { createClient } from "npm:@supabase/supabase-js@2";
import { generateCode, hashCode } from "../_shared/twoFactorEmail.ts";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";
import { logOtpUsage } from "../_shared/otpUsageLog.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const FP_RE = /^([a-f0-9]{64}|fb_[a-f0-9]{1,64})$/;
const OTP_CATEGORY = "device_step_up";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const NOT_REQUIRED = { required: false };

function enforced(): boolean {
  return (Deno.env.get("DEVICE_STEP_UP_ENFORCE") ?? "false").toLowerCase() === "true";
}

/** +256 *** *** 123 — safe to show on screen. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 3 ? `*** *** ${digits.slice(-3)}` : "your phone";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!token) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    const user = userData?.user;
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "check");
    const deviceFp = String(body?.device_fp ?? "").trim();
    if (!FP_RE.test(deviceFp)) return json(NOT_REQUIRED);

    const { data: profile } = await admin
      .from("profiles")
      .select("phone, full_name")
      .eq("id", user.id)
      .maybeSingle();
    const phone = String(profile?.phone ?? "").trim();
    const reachable = Boolean(phone) && isUgandanPhone(phone);

    if (action === "check") {
      const hwFp = String(body?.hw_fp ?? "").trim();
      const { data: result, error } = await admin.rpc("register_login_device", {
        p_user_id: user.id,
        p_device_fp: deviceFp,
        p_hw_fp: FP_RE.test(hwFp) ? hwFp : null,
        p_user_agent: String(body?.user_agent ?? "").slice(0, 300) || null,
      });
      if (error) {
        console.error("[device-step-up] register_login_device failed:", error.message);
        return json(NOT_REQUIRED);
      }
      const needed = Boolean((result as { step_up_required?: boolean })?.step_up_required);
      if (!needed || !enforced()) return json({ ...NOT_REQUIRED, observed: needed });
      // No phone we can text: never lock the account out. The device stays flagged
      // for review in get_shared_login_devices.
      if (!reachable) return json({ ...NOT_REQUIRED, unreachable: true });
      return json({ required: true, phone_masked: maskPhone(phone) });
    }

    // request / verify only make sense while this account is waiting for a code here.
    const { data: device } = await admin
      .from("login_devices")
      .select("step_up_required_at, step_up_verified_at")
      .eq("device_fp", deviceFp)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!device?.step_up_required_at || device.step_up_verified_at || !enforced()) {
      return json({ success: true, required: false });
    }
    if (!reachable) return json({ success: true, required: false, unreachable: true });

    if (action === "request") {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await admin
        .from("device_step_up_challenges")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", oneHourAgo);
      if ((count ?? 0) >= MAX_CODES_PER_HOUR) {
        return json({ error: "Too many codes requested. Please wait an hour and try again." }, 429);
      }

      const code = generateCode();
      const { error: insErr } = await admin.from("device_step_up_challenges").insert({
        user_id: user.id,
        device_fp: deviceFp,
        code_hash: await hashCode(user.id, deviceFp, code),
        phone,
        expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
      });
      if (insErr) return json({ error: "Could not create a code. Please try again." }, 500);

      const sent = await sendSMS(
        phone,
        `Welile: ${code} is your code to sign in on this phone. It expires in ${CODE_TTL_MINUTES} minutes. Never share it with anyone.`,
        {
          admin,
          source: "device-step-up",
          recipient_user_id: user.id,
          recipient_name: (profile?.full_name as string | null) ?? null,
        },
      );
      await logOtpUsage(admin, OTP_CATEGORY, sent ? "sent" : "send_failed", phone, "device-step-up");
      if (!sent) return json({ error: "Could not send the code. Please try again." }, 502);
      return json({ success: true, phone_masked: maskPhone(phone) });
    }

    if (action === "verify") {
      const code = String(body?.code ?? "").replace(/\D/g, "");
      if (code.length !== 6) return json({ error: "Enter the 6-digit code." }, 400);

      const { data: challenge } = await admin
        .from("device_step_up_challenges")
        .select("id, code_hash, attempts, expires_at")
        .eq("user_id", user.id)
        .eq("device_fp", deviceFp)
        .is("consumed_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!challenge) return json({ error: "No active code. Request a new one." }, 400);
      if (new Date(challenge.expires_at).getTime() < Date.now()) {
        return json({ error: "That code expired. Request a new one." }, 400);
      }
      if ((challenge.attempts ?? 0) >= MAX_ATTEMPTS) {
        return json({ error: "Too many wrong attempts. Request a new code." }, 429);
      }

      if ((await hashCode(user.id, deviceFp, code)) !== challenge.code_hash) {
        await admin
          .from("device_step_up_challenges")
          .update({ attempts: (challenge.attempts ?? 0) + 1 })
          .eq("id", challenge.id);
        await logOtpUsage(admin, OTP_CATEGORY, "verify_failed", phone, "device-step-up");
        const left = MAX_ATTEMPTS - ((challenge.attempts ?? 0) + 1);
        return json({ error: left > 0 ? `Wrong code. ${left} tries left.` : "Too many wrong attempts. Request a new code." }, 400);
      }

      await admin
        .from("device_step_up_challenges")
        .update({ consumed_at: new Date().toISOString() })
        .eq("id", challenge.id);
      await admin
        .from("login_devices")
        .update({ step_up_verified_at: new Date().toISOString() })
        .eq("device_fp", deviceFp)
        .eq("user_id", user.id);
      await logOtpUsage(admin, OTP_CATEGORY, "verify_success", phone, "device-step-up");
      return json({ success: true, required: false });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[device-step-up] unexpected:", e);
    return json(NOT_REQUIRED);
  }
});
