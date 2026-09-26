import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Creates a PHONE-ONLY (synthetic-email) account entirely server-side using the
 * admin API. This NEVER triggers the built-in mailer, so phone-only recruits are
 * no longer blocked by "email rate limit exceeded" when the shared SMTP quota is
 * exhausted. The account is created pre-confirmed so the recruit can sign in
 * immediately after their SMS OTP.
 *
 * Guard rails (all must hold):
 *  - The email must be a synthetic `<phone>@welile.user` / `@welile.agent`
 *    placeholder (real-email signups keep the normal client signUp + email flow).
 *  - A recent VERIFIED OTP (otp_verifications.verified = true within 30 min) must
 *    exist for the same last-9-digit phone, proving the number was SMS-verified.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();
    const rawPhone = String(body.phone || "").replace(/\D/g, "");
    const phoneKey = rawPhone.slice(-9);
    const referrerId = body.referrer_id ? String(body.referrer_id).trim() : null;
    const intendedRole = body.intended_role ? String(body.intended_role).trim() : null;
    const signupSource = body.signup_source ? String(body.signup_source).trim() : null;
    const campaignAttributionToken = body.campaign_attribution_token
      ? String(body.campaign_attribution_token).trim()
      : null;
    // Device fingerprint, forwarded into user_metadata so handle_new_user can
    // enforce one account per device per 24 hours. That gate lives on the
    // auth.users trigger precisely because this edge function, and the
    // client-side signupGuard, can both be skipped by posting at the Auth REST
    // endpoint directly. Shape-checked here as well so a junk value never
    // reaches the trigger and dodges the count by matching nothing.
    const rawDeviceFp = body.device_fp ? String(body.device_fp).trim() : "";
    const deviceFp =
      /^[a-f0-9]{64}$/.test(rawDeviceFp) || /^fb_[a-f0-9]{1,64}$/.test(rawDeviceFp)
        ? rawDeviceFp
        : null;

    // Only synthetic phone-only accounts are allowed through this path.
    if (!email.endsWith("@welile.user") && !email.endsWith("@welile.agent")) {
      return new Response(JSON.stringify({ error: "This endpoint only creates phone-only accounts" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (phoneKey.length !== 9 || password.length < 6 || !fullName) {
      return new Response(JSON.stringify({ error: "A valid phone, name and password are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Proof of SMS verification: a verified, recent OTP for this phone.
    const { data: otpRecord } = await adminClient
      .from("otp_verifications")
      .select("verified, verified_at")
      .eq("phone", phoneKey)
      .maybeSingle();
    const verifiedAtMs = otpRecord?.verified_at ? new Date(otpRecord.verified_at).getTime() : 0;
    const withinWindow = verifiedAtMs > 0 && (Date.now() - verifiedAtMs) < 30 * 60 * 1000;
    if (!otpRecord?.verified || !withinWindow) {
      return new Response(JSON.stringify({ error: "Phone not verified recently" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reject early if this phone is already tied to an existing profile —
    // otherwise `createUser` succeeds against a different synthetic email and
    // the `handle_new_user` trigger later fails on the profiles.phone unique
    // constraint, leaving an orphan auth.users row and a confused UX.
    const { data: existingProfile } = await adminClient
      .from("profiles")
      .select("id")
      .or(`phone.ilike.%${phoneKey},phone.eq.${rawPhone}`)
      .limit(1)
      .maybeSingle();
    if (existingProfile?.id) {
      return new Response(
        JSON.stringify({ error: "This phone number is already registered. Please sign in instead." }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Build metadata identical to the client signUp path so the `handle_new_user`
    // trigger creates the profile / referral / sub-agent links exactly the same.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const meta: Record<string, unknown> = {
      full_name: fullName,
      phone: rawPhone,
      referrer_id: referrerId && UUID_RE.test(referrerId) ? referrerId.toLowerCase() : null,
      intended_role: intendedRole || null,
    };
    if (signupSource) meta.signup_source = signupSource;
    if (deviceFp) meta.device_fp = deviceFp;
    if (campaignAttributionToken) meta.campaign_attribution_token = campaignAttributionToken;

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: meta,
    });

    if (createErr) {
      const msg = (createErr.message || "").toLowerCase();
      let friendly = "Could not create your account. Please try again.";
      let status = 500;
      if (msg.includes("already been registered") || msg.includes("already registered") || msg.includes("phone_already_registered") || msg.includes("duplicate")) {
        friendly = "This phone number is already registered. Please sign in instead.";
        status = 409;
      } else if (msg.includes("fraud")) {
        friendly = "This phone/name is permanently restricted for fraud review and cannot create a Welile account.";
        status = 403;
      }
      return new Response(JSON.stringify({ error: friendly, raw: createErr.message }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (campaignAttributionToken && created.user?.id) {
      await adminClient.rpc("complete_campaign_attribution_for_user", {
        p_token: campaignAttributionToken,
        p_user_id: created.user.id,
      });
    }

    return new Response(JSON.stringify({ success: true, user_id: created.user?.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unexpected error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
