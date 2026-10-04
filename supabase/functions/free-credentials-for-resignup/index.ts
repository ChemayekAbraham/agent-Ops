import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Free credentials on an ARCHIVED account so the original phone/email can be
 * used to register a brand-new account. Does NOT un-archive — the old record
 * stays archived (and audit-linked), it just no longer holds the phone/email
 * on `profiles` (unique constraint), and any leftover auth identifiers get
 * scrambled.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const { data: { user: caller }, error: authErr } = await admin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !caller) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("role", "manager")
      .eq("enabled", true);
    if (!roles || roles.length === 0) {
      return json({ error: "Forbidden: Manager role required" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const user_id = body?.user_id as string | undefined;
    const reason = (body?.reason ?? "").toString().trim();

    if (!user_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)) {
      return json({ error: "Valid user_id is required" }, 400);
    }
    if (reason.length < 10) {
      return json({ error: "Reason must be at least 10 characters" }, 400);
    }

    // Snapshot BEFORE
    const [{ data: profile, error: profileErr }, { data: authUser }] = await Promise.all([
      admin.from("profiles").select("id, full_name, email, phone, tenant_status").eq("id", user_id).maybeSingle(),
      admin.auth.admin.getUserById(user_id),
    ]);
    if (profileErr) return json({ error: profileErr.message }, 500);
    if (!profile) return json({ error: "Profile not found" }, 404);

    // Safety: only allow on already-archived profiles to avoid wiping live users
    const isArchived =
      (profile.full_name || "").toUpperCase().startsWith("[ARCHIVED]") ||
      !!authUser?.user?.deleted_at;
    if (!isArchived) {
      return json({ error: "Refusing to free credentials on a non-archived account. Archive the account first." }, 409);
    }

    const before = {
      profile_email: profile.email ?? null,
      profile_phone: profile.phone ?? null,
      auth_email: authUser?.user?.email ?? null,
      auth_phone: authUser?.user?.phone ?? null,
      full_name: profile.full_name ?? null,
    };

    // 1. NULL out profile.phone / email so unique constraints free up.
    //    Use a placeholder email so anything that requires a non-null email keeps working.
    const placeholderEmail = `freed+${user_id}@archived.local`;
    const { error: profUpdErr } = await admin
      .from("profiles")
      .update({
        email: placeholderEmail,
        phone: null,
        tenant_status: "inactive",
      })
      .eq("id", user_id);
    if (profUpdErr) {
      return json({ error: `Failed to free profile credentials: ${profUpdErr.message}` }, 500);
    }

    // 2. Scramble auth.users email/phone if still present (e.g. account was archived
    //    via UI but auth row never soft-deleted). Best-effort.
    let authScrambled = false;
    if (authUser?.user) {
      const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const updates: Record<string, unknown> = {};
      if (authUser.user.email) updates.email = `freed+${rand}@archived.local`;
      if (authUser.user.phone) updates.phone = null;
      if (Object.keys(updates).length > 0) {
        const { error: aErr } = await admin.auth.admin.updateUserById(user_id, updates);
        if (!aErr) authScrambled = true;
      }
    }

    const after = {
      profile_email: placeholderEmail,
      profile_phone: null,
      auth_scrambled: authScrambled,
    };

    await admin.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "credentials_freed_for_resignup",
      action: "credentials_freed_for_resignup",
      table_name: "profiles",
      record_id: user_id,
      metadata: {
        reason,
        performed_by: caller.id,
        performed_by_email: caller.email,
        before,
        after,
      },
    });

    return json({
      success: true,
      user_id,
      freed_phone: before.profile_phone,
      freed_email: before.profile_email,
      message: "Credentials freed. The user can now register again with the same phone/email.",
    });
  } catch (e) {
    console.error("free-credentials-for-resignup error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});