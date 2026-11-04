import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const origin = req.headers.get("origin") || "";
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    null;
  const userAgent = req.headers.get("user-agent") || null;

  // Fire-and-forget audit writer. Never throws — logging must not block or
  // break the OTP sign-in flow.
  const writeAudit = async (entry: {
    phone?: string | null;
    resolved_user_id?: string | null;
    outcome: string;
    reason?: string | null;
    stage?: string | null;
    expected_user_id?: string | null;
    actual_user_id?: string | null;
    metadata?: Record<string, unknown>;
  }) => {
    try {
      await adminClient.from("otp_login_audit").insert([{
        phone: entry.phone ?? null,
        resolved_user_id: entry.resolved_user_id ?? null,
        outcome: entry.outcome,
        reason: entry.reason ?? null,
        stage: entry.stage ?? null,
        expected_user_id: entry.expected_user_id ?? null,
        actual_user_id: entry.actual_user_id ?? null,
        origin: origin || null,
        ip_address: ipAddress,
        user_agent: userAgent,
        metadata: (entry.metadata ?? {}) as Record<string, unknown>,
      }]);
    } catch (e) {
      console.warn("[otp-login] audit write failed:", e instanceof Error ? e.message : e);
    }
  };

  try {
    const body = await req.json();

    // Mode B: client-reported profile/session mismatch after the magic-link
    // redirect resolved the wrong account. Logged with both the expected and
    // actual user ids so the divergence is fully auditable.
    if (body?.action === "report_mismatch") {
      await writeAudit({
        phone: body.phone ?? null,
        resolved_user_id: body.expected_user_id ?? null,
        outcome: "session_mismatch",
        stage: "client_session_guard",
        reason: "Resolved auth user id did not match the established session user id; sign-in aborted on client.",
        expected_user_id: body.expected_user_id ?? null,
        actual_user_id: body.actual_user_id ?? null,
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { phone, otp } = body;

    if (!phone || !otp) {
      await writeAudit({ phone: phone ?? null, outcome: "rejected", stage: "validation", reason: "Phone and OTP are required" });
      return new Response(JSON.stringify({ error: "Phone and OTP are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Clean phone digits
    const digits = phone.replace(/\D/g, "");
    const last9 = digits.slice(-9);

    // Step 1: Verify OTP from otp_verifications table
    const phoneVariants = [`0${last9}`, `256${last9}`, last9, `+256${last9}`];
    
    // The guess is deliberately NOT part of this search: a wrong guess must still
    // find the row so it can be counted below (see register_otp_attempt).
    const { data: otpRecord, error: otpError } = await adminClient
      .from("otp_verifications")
      .select("id, otp_code")
      .in("phone", phoneVariants)
      .eq("verified", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (otpError || !otpRecord) {
      await writeAudit({ phone, outcome: "failed", stage: "otp_verify", reason: "No active code." });
      return new Response(JSON.stringify({ error: "Code expired or not found. Please request a new one." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use up one attempt BEFORE comparing, atomically in the database, so a
    // burst of parallel guesses cannot all read the same old count.
    const { data: attemptsUsed, error: attemptError } = await adminClient
      .rpc("register_otp_attempt", { p_otp_id: otpRecord.id });

    // Fail closed: if we cannot count the guess, we do not check it.
    if (attemptError || attemptsUsed === null) {
      console.error("[otp-login] register_otp_attempt failed:", attemptError?.message);
      return new Response(JSON.stringify({ error: "Could not verify code. Please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (attemptsUsed > 5) {
      await writeAudit({ phone, outcome: "rejected", stage: "rate_limit", reason: "Too many attempts." });
      return new Response(JSON.stringify({ error: "Too many attempts. Please request a new code." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only now compare the guess to the stored code.
    if (String(otpRecord.otp_code) !== String(otp)) {
      await writeAudit({ phone, outcome: "failed", stage: "otp_verify", reason: "Invalid code." });
      return new Response(JSON.stringify({ error: "Invalid code. Please check and try again." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Mark OTP as verified
    await adminClient
      .from("otp_verifications")
      .update({ verified: true, verified_at: new Date().toISOString() })
      .eq("id", otpRecord.id);

    // Step 2: Find user by phone in profiles
    const { data: profileMatches } = await adminClient
      .from("profiles")
      .select("id, email, full_name")
      .in("phone", phoneVariants)
      .limit(5);

    if (!profileMatches?.length) {
      await writeAudit({ phone, outcome: "no_account", stage: "profile_lookup", reason: "No account found with this phone number." });
      return new Response(JSON.stringify({ error: "No account found with this phone number. Please sign up first." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pick the best match (prefer real email over placeholder)
    const profile = profileMatches.find(p => p.email && !p.email.includes("@welile.")) || profileMatches[0];
    const userId = profile.id;

    // Step 3: Resolve the CANONICAL auth account for this user id.
    // The profiles.email column can drift from auth.users.email (e.g. the user
    // changed their login email). Generating a magic link from the (possibly
    // stale) profiles.email would either fail or silently create a brand-new
    // empty account — bringing up the wrong account. We must use the email
    // that auth.users actually has for THIS user id so OTP always lands on the
    // real account linked to that profile.
    const { data: authUserData, error: authUserError } = await adminClient.auth.admin.getUserById(userId);
    if (authUserError || !authUserData?.user?.email) {
      console.error("[otp-login] getUserById error:", authUserError);
      await writeAudit({ phone, resolved_user_id: userId, outcome: "error", stage: "auth_resolve", reason: "Could not locate canonical auth account for resolved profile." });
      return new Response(JSON.stringify({ error: "Could not locate your account. Please try password login." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const email = authUserData.user.email;

    // Step 3b: Generate a magic link / session via admin API against the
    // canonical auth email so we always log into the real linked account.
    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "magiclink",
      email: email,
      options: {
        redirectTo: `${req.headers.get("origin") || supabaseUrl}`,
      },
    });

    if (linkError || !linkData) {
      console.error("[otp-login] generateLink error:", linkError);
      await writeAudit({ phone, resolved_user_id: userId, outcome: "error", stage: "generate_link", reason: "Failed to create login session." });
      return new Response(JSON.stringify({ error: "Failed to create login session. Please try password login." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Extract the token from the generated link properties
    const tokenHash = linkData.properties?.hashed_token;
    const verifyUrl = `${supabaseUrl}/auth/v1/verify?token=${tokenHash}&type=magiclink&redirect_to=${encodeURIComponent(req.headers.get("origin") || "")}`;

    // Store last login method for the user
    await adminClient
      .from("profiles")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", userId);

    console.log(`[otp-login] OTP login successful for user ${userId}`);

    await writeAudit({
      phone,
      resolved_user_id: userId,
      outcome: "success",
      stage: "magic_link_issued",
      reason: "Magic link issued for canonical auth account.",
      metadata: { profile_matches: profileMatches.length, email_was_placeholder: email.includes("@welile.") },
    });

    return new Response(JSON.stringify({ 
      success: true, 
      // Preferred path: the client calls supabase.auth.verifyOtp({ type:'magiclink',
      // token_hash }) which establishes the session FIRST-PARTY (same-origin
      // fetch). This avoids the cross-domain bounce through <project>.supabase.co
      // that iOS Safari ITP classifies as bounce-tracking and evicts on the next
      // cold launch — the root cause of iPhone users being logged out.
      token_hash: tokenHash,
      // Legacy fallback (older clients) — performs the cross-domain redirect.
      verify_url: verifyUrl,
      user_name: profile.full_name,
      // Resolved canonical auth user id. The client stores this and, after the
      // magic-link redirect establishes a session, verifies the new session's
      // user id matches it before completing sign-in. If they differ (e.g. the
      // magic link resolved a different/stale account), the client aborts and
      // signs out instead of landing the user on the wrong account.
      user_id: userId,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[otp-login] Error:", msg);
    await writeAudit({ outcome: "error", stage: "exception", reason: msg });
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
