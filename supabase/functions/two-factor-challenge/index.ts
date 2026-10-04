// Email-code challenge for two-step verification (2MFA).
//
//   action: "status"  -> is 2MFA on, and is THIS device already verified?
//   action: "request" -> mail a 6-digit code to the account's inbox
//   action: "verify"  -> check the code and mark this device verified
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateCode, hashCode, isUnusableEmail, maskEmail } from "../_shared/twoFactorEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

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
    const action = String(body?.action ?? "status");
    const deviceId = String(body?.device_id ?? "").trim();
    const deviceLabel = String(body?.device_label ?? "").trim().slice(0, 60) || null;
    if (!deviceId) return json({ error: "Missing device id" }, 400);

    const { data: config } = await admin
      .from("user_two_factor")
      .select("enabled, email")
      .eq("user_id", user.id)
      .maybeSingle();

    const enabled = config?.enabled === true;
    const { data: trusted } = await admin
      .from("user_2fa_trusted_devices")
      .select("id")
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .maybeSingle();

    let email = config?.email ?? user.email ?? null;
    if (isUnusableEmail(email)) {
      const { data: profile } = await admin
        .from("profiles")
        .select("email")
        .eq("id", user.id)
        .maybeSingle();
      email = profile?.email ?? null;
    }

    if (action === "status") {
      return json({
        enabled,
        device_trusted: Boolean(trusted),
        email_masked: email && !isUnusableEmail(email) ? maskEmail(email) : null,
      });
    }

    if (!enabled) return json({ success: true, enabled: false, device_trusted: true });

    if (action === "request") {
      if (trusted) return json({ success: true, device_trusted: true });
      if (isUnusableEmail(email)) {
        return json({ error: "No email address on file for this account.", code: "no_email" }, 400);
      }

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await admin
        .from("user_2fa_challenges")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", oneHourAgo);
      if ((count ?? 0) >= MAX_CODES_PER_HOUR) {
        return json(
          { error: "Too many codes requested. Please wait an hour and try again." },
          429,
        );
      }

      const code = generateCode();
      const codeHash = await hashCode(user.id, deviceId, code);
      const { error: insErr } = await admin.from("user_2fa_challenges").insert({
        user_id: user.id,
        device_id: deviceId,
        code_hash: codeHash,
        email: email!.toLowerCase(),
        expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
      });
      if (insErr) return json({ error: insErr.message }, 500);

      const { data: profile } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();

      const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "two-factor-code",
          recipientEmail: email!.toLowerCase(),
          templateData: {
            code,
            userName: (profile?.full_name as string | null)?.split(" ")[0] || "there",
            deviceLabel: deviceLabel || "A new device",
            requestedAt: new Date().toISOString(),
            minutesValid: CODE_TTL_MINUTES,
          },
        },
      });
      if (mailErr) {
        console.error("[two-factor-challenge] email send failed:", mailErr);
        return json({ error: "Could not send the code. Please try again." }, 502);
      }

      return json({ success: true, email_masked: maskEmail(email!) });
    }

    if (action === "verify") {
      const code = String(body?.code ?? "").replace(/\D/g, "");
      if (code.length !== 6) return json({ error: "Enter the 6-digit code." }, 400);

      const { data: challenge } = await admin
        .from("user_2fa_challenges")
        .select("id, code_hash, attempts, expires_at, consumed_at")
        .eq("user_id", user.id)
        .eq("device_id", deviceId)
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

      const expected = await hashCode(user.id, deviceId, code);
      if (expected !== challenge.code_hash) {
        await admin
          .from("user_2fa_challenges")
          .update({ attempts: (challenge.attempts ?? 0) + 1 })
          .eq("id", challenge.id);
        const left = MAX_ATTEMPTS - ((challenge.attempts ?? 0) + 1);
        return json(
          { error: left > 0 ? `Wrong code. ${left} attempts left.` : "Too many wrong attempts. Request a new code." },
          400,
        );
      }

      await admin
        .from("user_2fa_challenges")
        .update({ consumed_at: new Date().toISOString() })
        .eq("id", challenge.id);

      await admin.from("user_2fa_trusted_devices").upsert(
        {
          user_id: user.id,
          device_id: deviceId,
          device_label: deviceLabel,
          approved_at: new Date().toISOString(),
          last_verified_at: new Date().toISOString(),
        },
        { onConflict: "user_id,device_id" },
      );

      return json({ success: true, device_trusted: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("[two-factor-challenge] failed:", err);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
