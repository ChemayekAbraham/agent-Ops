// Step 1 of self-service email verification: mail a 6-digit code to the
// address the signed-in user has just typed.
//
// Nothing is written to `profiles.email` here. The address is adopted only in
// email-verify-confirm, once the user proves they can read the inbox. That is
// the whole point: before this pair of functions existed, EmailEditor wrote
// profiles.email immediately and the column recorded a claim, not a fact.
//
// Self-service only. The JWT identifies the user and we never accept a
// user_id from the body, so an agent cannot run this for somebody else.

import { createClient } from "npm:@supabase/supabase-js@2";
import { isPlaceholderRecipient } from "../_shared/recipientMailbox.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CODE_TTL_MINUTES = 15;
const MAX_SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MINUTES = 15;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Hash bound to the user and the address, so a hash alone is useless elsewhere. */
async function hashCode(code: string, userId: string, email: string): Promise<string> {
  const pepper = Deno.env.get("EMAIL_VERIFY_PEPPER") ?? "";
  const data = new TextEncoder().encode(`${code}:${userId}:${email}:${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const newEmail = String(body?.email ?? "").trim().toLowerCase();

    if (!newEmail || newEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return json({ error: "invalid_email", message: "Enter a valid email address." }, 400);
    }

    // The address must be able to receive mail. This is the same guard every
    // send path uses, so it rejects our own placeholder domains, disposable
    // inboxes and near-miss typos like gmail.comm in one call.
    if (isPlaceholderRecipient(newEmail)) {
      return json({
        error: "undeliverable_email",
        message: "That address cannot receive mail. Use a real inbox such as Gmail.",
      }, 400);
    }

    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("id, email, full_name")
      .eq("id", userId)
      .maybeSingle();
    if (profErr || !profile) return json({ error: "profile_not_found" }, 404);

    const oldEmail = String(profile.email ?? "").trim().toLowerCase();
    // purpose 'confirm_current': prove the inbox for the address already on the
    // profile (agent vetting). Confirming it rewrites the same address, so
    // nothing changes except that it is now known to receive mail.
    const confirmCurrent = body?.purpose === "confirm_current";
    if (oldEmail === newEmail && !confirmCurrent) {
      return json({ error: "unchanged", message: "That is already your email address." }, 400);
    }

    // One live account per address.
    const { data: taken } = await admin
      .from("profiles")
      .select("id")
      .eq("email", newEmail)
      .neq("id", userId)
      .limit(1);
    if (taken && taken.length > 0) {
      return json({
        error: "email_taken",
        message: "That address is already on another Welile account.",
      }, 409);
    }

    // Resend throttle.
    const windowStart = new Date(Date.now() - SEND_WINDOW_MINUTES * 60_000).toISOString();
    const { count: recentSends } = await admin
      .from("email_verification_challenges")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", windowStart);
    if ((recentSends ?? 0) >= MAX_SENDS_PER_WINDOW) {
      return json({
        error: "too_many_requests",
        message: `Too many codes requested. Try again in ${SEND_WINDOW_MINUTES} minutes.`,
      }, 429);
    }

    const code = sixDigitCode();
    const codeHash = await hashCode(code, userId, newEmail);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

    const { data: challenge, error: insErr } = await admin
      .from("email_verification_challenges")
      .insert({
        user_id: userId,
        new_email: newEmail,
        old_email: oldEmail,
        code_hash: codeHash,
        expires_at: expiresAt,
        ip_address: req.headers.get("x-forwarded-for"),
        user_agent: req.headers.get("user-agent"),
      })
      .select("id, expires_at")
      .single();
    if (insErr || !challenge) {
      console.error("challenge insert failed", insErr);
      return json({ error: "could_not_start", message: "Could not start verification." }, 500);
    }

    const { data: mailRes, error: mailErr } = await admin.functions.invoke("send-transactional-email", {
      body: {
        templateName: "email-verification-code",
        recipientEmail: newEmail,
        templateData: {
          code,
          userName: String(profile.full_name ?? "there").split(" ")[0] || "there",
          minutesValid: CODE_TTL_MINUTES,
        },
      },
    });
    // send-transactional-email answers 200 with { success: false } when it
    // declines to send (suppressed recipient, unsubscribed, provider refusal),
    // so an absent `error` is NOT proof the code went out.
    const mailDeclined = mailRes && (mailRes as { success?: boolean }).success === false;
    if (mailErr || mailDeclined) {
      console.error("verification email failed", mailErr ?? mailRes);
      // Burn the challenge so the throttle does not punish a send we never made.
      await admin.from("email_verification_challenges")
        .update({ consumed_at: new Date().toISOString(), failure_reason: "send_failed" })
        .eq("id", challenge.id);
      return json({ error: "send_failed", message: "Could not send the code. Try again." }, 502);
    }

    return json({
      status: "sent",
      challenge_id: challenge.id,
      expires_at: challenge.expires_at,
    });
  } catch (e) {
    console.error("email-verify-request failed", e);
    return json({ error: "unexpected", message: String(e) }, 500);
  }
});
