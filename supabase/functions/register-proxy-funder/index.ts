import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateFullName, FULL_NAME_ERROR } from "../_shared/validateFullName.ts";
import { guardAgentAssistedSignup, attachAgentSignupUser } from "../_shared/agentSignupGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  // Normalize to local Uganda format-friendly digits, accept many inputs.
  if (digits.startsWith("256") && digits.length >= 12) return digits.slice(0, 12);
  if (digits.startsWith("0") && digits.length === 10) return `256${digits.slice(1)}`;
  if (digits.length === 9) return `256${digits}`;
  if (digits.length >= 9 && digits.length <= 15) return digits;
  return digits;
}

function toE164(digits: string): string {
  // Supabase Auth's createUser expects E.164 with leading '+'.
  return digits.startsWith("+") ? digits : `+${digits}`;
}

function friendlyAuthError(msg: string): string {
  if (/E\.?164/i.test(msg) || /phone/i.test(msg) && /format/i.test(msg)) {
    return "That phone number doesn't look right. Use a Uganda format like 0704825473, 256704825473, or +256704825473.";
  }
  if (/already (been )?registered|duplicate/i.test(msg)) {
    return "This phone number is already registered.";
  }
  return msg;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Authenticate the caller — attribution must never come from the request body.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: callerData, error: callerError } = await supabase.auth.getUser(token);
    const callerId = callerData?.user?.id;
    if (callerError || !callerId) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { full_name, phone, notes, telemetry } = await req.json();
    // Attribution is always the authenticated caller.
    const agent_id = callerId;

    if (!phone) {
      return new Response(
        JSON.stringify({ error: "phone is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const nameCheck = validateFullName(full_name);
    if (!nameCheck.valid) {
      return new Response(
        JSON.stringify({ error: nameCheck.error || FULL_NAME_ERROR }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const cleanFullName = nameCheck.trimmed;

    const normalizedPhone = normalizePhone(phone);
    const local9 = normalizedPhone.slice(-9);
    if (local9.length !== 9) {
      return new Response(
        JSON.stringify({ error: "That phone number doesn't look right. Use a Uganda format like 0704825473 or +256704825473." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if phone already exists
    const phoneFormats = [local9, `0${local9}`, `256${local9}`, `+256${local9}`];
    const { data: existing } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("phone", phoneFormats)
      .limit(1);

    if (existing && existing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Phone already registered to ${existing[0].full_name || "another user"}` }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create auth user (no password — USSD-only user)
    // Anti-bot guard: log device fingerprint + true source screen, enforce burst cap.
    const guard = await guardAgentAssistedSignup(supabase as any, {
      req,
      actorUserId: agent_id,
      telemetry,
      phone: normalizedPhone,
      targetRole: "funder",
    });
    if (!guard.allowed) {
      return new Response(
        JSON.stringify({ error: guard.reason || "Registration temporarily blocked by the anti-bot guard.", status: guard.status }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      phone: toE164(normalizedPhone),
      email: `${normalizedPhone}@proxy.welile.local`,
      phone_confirm: true,
      email_confirm: true,
      user_metadata: { full_name: cleanFullName, registered_by_agent: agent_id },
    });

    if (authError) {
      return new Response(
        JSON.stringify({ error: friendlyAuthError(authError.message) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = authData.user.id;
    await attachAgentSignupUser(supabase as any, guard.attempt_id, userId);

    // Insert profile
    const { error: profileError } = await supabase.from("profiles").upsert({
      id: userId,
      full_name: cleanFullName,
      phone: normalizedPhone,
      registration_method: "proxy_agent",
    });

    if (profileError) {
      console.error("Profile insert error:", profileError);
    }

    // Insert supporter role
    const { error: roleError } = await supabase.from("user_roles").insert({
      user_id: userId,
      role: "supporter",
    });

    if (roleError) {
      console.error("Role insert error:", roleError);
    }

    // Create wallet
    const { error: walletError } = await supabase.from("wallets").insert({
      user_id: userId,
      balance: 0,
    });

    if (walletError) {
      console.error("Wallet insert error:", walletError);
    }

    // Create proxy assignment (pending approval)
    const { error: proxyError } = await supabase.from("proxy_agent_assignments").insert({
      agent_id,
      beneficiary_id: userId,
      beneficiary_role: "supporter",
      assigned_by: agent_id,
      reason: notes || "No-smartphone funder registered by agent",
      is_active: false,
      approval_status: "pending",
    });

    if (proxyError) {
      console.error("Proxy assignment error:", proxyError);
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      user_id: agent_id,
      action: "register_proxy_funder",
      details: `Registered no-smartphone funder: ${full_name} (${normalizedPhone})`,
      target_user_id: userId,
      is_proxy: true,
      audit_reason: `Agent proxy registration for funder without smartphone: ${full_name}`,
    });

    return new Response(
      JSON.stringify({ success: true, funder_id: userId, full_name, phone: normalizedPhone }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("register-proxy-funder error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
