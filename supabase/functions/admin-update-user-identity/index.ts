import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ADMIN_ROLES = ["manager", "cto", "super_admin", "ceo", "coo", "cfo", "cmo", "operations"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizePhone(raw: string): string {
  // E.164-ish: strip spaces/dashes, keep leading +. If starts with 0 -> assume UG (+256)
  const trimmed = raw.trim().replace(/[\s-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("0")) return "+256" + trimmed.slice(1);
  if (/^\d{9,15}$/.test(trimmed)) return "+" + trimmed;
  return trimmed;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authn
    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
    const caller = authData?.user;
    if (authErr || !caller) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Authz
    const { data: roleRows } = await adminClient
      .from("user_roles").select("role").eq("user_id", caller.id).eq("enabled", true).in("role", ADMIN_ROLES);
    if (!roleRows || roleRows.length === 0) {
      return new Response(JSON.stringify({ error: "You do not have permission to update user identity" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const { user_id, email, phone } = body as { user_id?: string; email?: string | null; phone?: string | null };
    if (!user_id || !UUID_RE.test(user_id)) throw new Error("Invalid user_id");
    if (email == null && phone == null) throw new Error("Provide email and/or phone");

    const authPatch: Record<string, unknown> = { email_confirm: true, phone_confirm: true };
    const profilePatch: Record<string, unknown> = {};

    let normalizedEmail: string | undefined;
    if (typeof email === "string") {
      const e = email.trim().toLowerCase();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("Invalid email");
      normalizedEmail = e || undefined;
      if (normalizedEmail) authPatch.email = normalizedEmail;
      profilePatch.email = normalizedEmail ?? null;
    }

    let normalizedPhone: string | undefined;
    if (typeof phone === "string") {
      const p = phone.trim();
      if (p) {
        normalizedPhone = normalizePhone(p);
        // auth.users.phone is stored without the leading "+"
        authPatch.phone = normalizedPhone.replace(/^\+/, "");
      } else {
        authPatch.phone = "";
      }
      profilePatch.phone = p || null;
    }

    // Pre-flight duplicate checks against auth.users so we can return a clear,
    // human-readable error instead of GoTrue's opaque AuthRetryableFetchError
    // (which is what a uniqueness conflict surfaces as).
    if (normalizedEmail) {
      const { data: emailMatch } = await adminClient
        .from("profiles").select("id, full_name").eq("email", normalizedEmail).neq("id", user_id).maybeSingle();
      // Also check auth directly via admin listing by scanning profiles first (fast),
      // then fall back to a targeted auth check.
      if (emailMatch) {
        return new Response(JSON.stringify({ error: `That email is already used by another account${emailMatch.full_name ? ` (${emailMatch.full_name})` : ""}. Use a different email.` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    if (normalizedPhone) {
      const phoneNoPlus = normalizedPhone.replace(/^\+/, "");
      const { data: phoneMatch } = await adminClient
        .from("profiles").select("id, full_name").or(`phone.eq.${normalizedPhone},phone.eq.${phoneNoPlus},phone.eq.0${phoneNoPlus.replace(/^256/, "")}`).neq("id", user_id).limit(1).maybeSingle();
      if (phoneMatch) {
        return new Response(JSON.stringify({ error: `That phone number is already used by another account${phoneMatch.full_name ? ` (${phoneMatch.full_name})` : ""}. Use a different number.` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // 1. Update auth.users
    const { error: updErr } = await adminClient.auth.admin.updateUserById(user_id, authPatch);
    if (updErr) {
      const m = (updErr as any)?.message?.toLowerCase() ?? "";
      const friendly = m.includes("email")
        ? "That email is already registered to another account. Use a different email."
        : m.includes("phone")
          ? "That phone number is already registered to another account. Use a different number."
          : "Could not update login identity — the email or phone may already be in use by another account.";
      return new Response(JSON.stringify({ error: friendly }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Mirror to profiles
    if (Object.keys(profilePatch).length > 0) {
      const { error: profErr } = await adminClient.from("profiles").update(profilePatch).eq("id", user_id);
      if (profErr) throw profErr;
    }

    // 3. Audit
    await adminClient.from("audit_logs").insert({
      actor_id: caller.id,
      action_type: "user_identity_update",
      table_name: "auth.users",
      record_id: user_id,
      reason: "platform_users_edit",
      details: { email: normalizedEmail ?? null, phone: normalizedPhone ?? null },
    });

    console.log(`[admin-update-user-identity] caller=${caller.id} target=${user_id} email=${normalizedEmail ?? "-"} phone=${normalizedPhone ?? "-"}`);

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
  } catch (error: any) {
    console.error("admin-update-user-identity error:", error);
    return new Response(JSON.stringify({ error: error?.message || "Failed", code: error?.code ?? null }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 });
  }
});