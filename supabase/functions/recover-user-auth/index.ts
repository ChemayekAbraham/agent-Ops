import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ADMIN_ROLES = ["manager", "cto", "super_admin", "ceo", "coo", "cfo", "operations"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Authenticate caller
    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    const caller = authData?.user;
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Authorize: must be admin-tier role
    const { data: roleRows } = await admin
      .from("user_roles").select("role").eq("user_id", caller.id).eq("enabled", true).in("role", ADMIN_ROLES);
    if (!roleRows || roleRows.length === 0) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { user_id, email, phone, reason } = await req.json();
    if (!user_id || !UUID_RE.test(user_id)) {
      return new Response(JSON.stringify({ error: "Valid user_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
      return new Response(JSON.stringify({ error: "reason (>=10 chars) required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const updates: Record<string, unknown> = {};
    if (email) { updates.email = email; updates.email_confirm = true; }
    if (phone) { updates.phone = phone; updates.phone_confirm = true; }

    // Capture before state for audit
    const { data: beforeUser } = await admin.auth.admin.getUserById(user_id);

    const { data, error } = await admin.auth.admin.updateUserById(user_id, updates);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Audit
    await admin.from("audit_logs").insert({
      action_type: "recover_user_auth",
      table_name: "auth.users",
      record_id: user_id,
      reason: reason.trim(),
      actor_id: caller.id,
      metadata: {
        before: { email: beforeUser?.user?.email ?? null, phone: beforeUser?.user?.phone ?? null },
        after: { email: data.user.email ?? null, phone: data.user.phone ?? null },
      },
    });

    return new Response(JSON.stringify({ success: true, user: { id: data.user.id, email: data.user.email, phone: data.user.phone } }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});