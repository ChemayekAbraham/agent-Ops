import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_ROLES = [
  "agent", "senior_agent", "manager", "cto", "super_admin",
  "ceo", "coo", "cfo", "operations",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authenticate caller
    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
    const caller = authData?.user;
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authorize: must be an agent-tier or admin role
    const { data: roleRows } = await adminClient
      .from("user_roles").select("role")
      .eq("user_id", caller.id).eq("enabled", true).in("role", ALLOWED_ROLES);
    if (!roleRows || roleRows.length === 0) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { phone, agent_name } = await req.json();

    if (!phone) {
      return new Response(JSON.stringify({ error: "Phone number is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const digits = phone.replace(/\D/g, "");
    const last9 = digits.slice(-9);
    const fullPhone = digits.startsWith("256") ? digits : `256${last9}`;

    // Check if user exists
    const { data: profiles } = await adminClient
      .from("profiles")
      .select("id, email, full_name")
      .in("phone", [`0${last9}`, `256${last9}`, last9])
      .limit(1);

    const userExists = profiles && profiles.length > 0;
    const profile = profiles?.[0];

    // Generate a short-lived OTP for the link
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Store OTP
    await adminClient.from("otp_verifications").upsert({
      phone: fullPhone,
      otp_code: otp,
      expires_at: expiresAt,
      verified: false,
      attempts: 0,
    }, { onConflict: "phone" });

    // Build the deep link — this is NEVER returned in the HTTP response.
    // It is only delivered out-of-band via SMS to the phone owner.
    const baseUrl = "https://welileapp.com";
    const linkParams = new URLSearchParams({
      phone: last9,
      token: otp,
      ...(agent_name ? { agent: agent_name } : {}),
    });
    const loginUrl = `${baseUrl}/auth?${linkParams.toString()}`;

    const greeting = profile?.full_name ? `Hi ${profile.full_name}` : "Hi";
    const agentLine = agent_name ? `Your agent ${agent_name} sent this link. ` : "";
    const smsBody = `${greeting}. ${agentLine}Tap to sign in to Welile: ${loginUrl} (expires in 10 min)`;

    // Deliver via SMS through the internal sender. The token is only sent
    // to the phone owner — never returned to the caller.
    try {
      await adminClient.functions.invoke("inngest-send-sms", {
        body: { phone: fullPhone, message: smsBody },
      });
    } catch (smsErr) {
      console.error("[whatsapp-login-link] SMS dispatch failed:", smsErr);
      return new Response(JSON.stringify({ error: "Failed to deliver login link" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[whatsapp-login-link] Dispatched login SMS to ***${last9.slice(-4)} for ${userExists ? "existing" : "new"} user by ${caller.id}`);

    return new Response(JSON.stringify({
      success: true,
      delivered: true,
      user_exists: userExists,
      user_name: profile?.full_name || null,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[whatsapp-login-link] Error:", msg);
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
