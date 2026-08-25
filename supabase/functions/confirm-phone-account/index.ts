import "../_shared/noSignupPrompt.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Auto-confirms a freshly created PHONE-ONLY signup so the recruit can log in
 * immediately without any email verification.
 *
 * Guard rails (all must hold, or we refuse):
 *  - The target account's email is a synthetic `<phone>@welile.user` placeholder
 *    (we NEVER touch accounts that used a real email — those keep email verification).
 *  - The account is currently unconfirmed.
 *  - The account's phone metadata matches a recently VERIFIED OTP record
 *    (otp_verifications.verified = true within the last 30 minutes) for the same
 *    last-9-digit phone key. This proves the phone was SMS-verified at signup.
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
    const userId = (body.user_id as string || "").trim();
    const rawPhone = (body.phone as string || "").replace(/\D/g, "");
    const phoneKey = rawPhone.slice(-9);

    if (!userId || phoneKey.length !== 9) {
      return new Response(JSON.stringify({ error: "user_id and a valid phone are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1) Proof of SMS verification: a verified, recent OTP for this phone.
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

    // 2) Load the target account and enforce the synthetic-email + phone-match rules.
    const { data: userWrap, error: getErr } = await adminClient.auth.admin.getUserById(userId);
    const user = userWrap?.user;
    if (getErr || !user) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const email = (user.email || "").toLowerCase();
    if (!email.endsWith("@welile.user")) {
      // Real-email account — never auto-confirm; email verification stands.
      return new Response(JSON.stringify({ error: "Account uses a real email; not eligible" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const metaPhone = String((user.user_metadata as Record<string, unknown> | null)?.phone ?? "").replace(/\D/g, "");
    const emailLocal = email.split("@")[0].replace(/\D/g, "");
    const matchesPhone = metaPhone.slice(-9) === phoneKey || emailLocal.slice(-9) === phoneKey;
    if (!matchesPhone) {
      return new Response(JSON.stringify({ error: "Phone does not match account" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (user.email_confirmed_at) {
      // Already confirmed — nothing to do.
      return new Response(JSON.stringify({ success: true, already_confirmed: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3) Confirm the synthetic email so the phone-verified user can sign in now.
    const { error: updErr } = await adminClient.auth.admin.updateUserById(userId, {
      email_confirm: true,
    });
    if (updErr) {
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
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
