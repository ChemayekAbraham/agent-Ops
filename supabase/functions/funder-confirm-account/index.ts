// Pre-confirm a freshly-created funder-onboarding account so the client can
// immediately establish a session and run the (RLS-gated) partnership-agreement
// email pipeline. Funders are vetted separately in /partner-onboarding, so email
// confirmation is not required for this flow — but the account must NOT be left
// in an unconfirmed state that blocks sign-in and silently drops the agreement
// email.
//
// Security: this endpoint only confirms accounts that (a) were created via the
// `funder-onboarding` signup source, (b) were created very recently, and (c) are
// not already confirmed. It never touches arbitrary accounts.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

// Only confirm accounts created within this window (minutes). A brand-new
// signup completes in seconds; anything older is not part of this flow.
const MAX_ACCOUNT_AGE_MINUTES = 60;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
    if (!userId) return json({ error: "userId is required" }, 400);

    // Load the auth user (source of truth for created_at + confirmation state).
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(userId);
    const authUser = userData?.user;
    if (userErr || !authUser) return json({ error: "User not found" }, 404);

    // Idempotent: already confirmed → nothing to do.
    if (authUser.email_confirmed_at) {
      return json({ ok: true, alreadyConfirmed: true });
    }

    // Guard 1: must be a genuine funder-onboarding signup.
    const { data: profile } = await admin
      .from("profiles")
      .select("signup_source, created_at")
      .eq("id", userId)
      .maybeSingle();
    if (!profile || profile.signup_source !== "funder-onboarding") {
      return json({ error: "Not eligible for auto-confirmation" }, 403);
    }

    // Guard 2: must be freshly created (limits any abuse window).
    const createdAt = new Date(authUser.created_at ?? profile.created_at ?? 0).getTime();
    const ageMinutes = (Date.now() - createdAt) / 60000;
    if (!Number.isFinite(ageMinutes) || ageMinutes > MAX_ACCOUNT_AGE_MINUTES) {
      return json({ error: "Account is not eligible for auto-confirmation" }, 403);
    }

    const { error: confirmErr } = await admin.auth.admin.updateUserById(userId, {
      email_confirm: true,
    });
    if (confirmErr) {
      console.error("[funder-confirm-account] confirm failed:", confirmErr.message);
      return json({ error: "Failed to confirm account" }, 500);
    }

    return json({ ok: true, confirmed: true });
  } catch (e) {
    console.error("[funder-confirm-account] error:", (e as Error)?.message || e);
    return json({ error: "Internal error" }, 500);
  }
});