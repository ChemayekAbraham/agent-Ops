import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Auth: this endpoint exposes authentication/profile diagnostics and must
    // never fall through without a verified admin-tier user.
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "") ?? "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roleData, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", authData.user.id)
      .eq("enabled", true)
      .in("role", ["manager", "cto", "super_admin"]);
    if (roleError || !roleData?.length) {
      return new Response(JSON.stringify({ error: "Forbidden - requires manager/cto/super_admin role" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Targeted lookup: if the caller passes specific userIds, return the exact
    // auth vs profile state for each so we can confirm an account is usable.
    let requestedIds: string[] = [];
    try {
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (Array.isArray(body?.userIds)) {
          requestedIds = body.userIds.filter((v: unknown) => typeof v === "string");
        }
      }
    } catch { /* no body */ }

    if (requestedIds.length > 0) {
      const results: Array<Record<string, unknown>> = [];
      for (const id of requestedIds) {
        const { data: au, error: auErr } = await supabaseAdmin.auth.admin.getUserById(id);
        const { data: prof } = await supabaseAdmin
          .from("profiles")
          .select("id, email, phone, full_name")
          .eq("id", id)
          .maybeSingle();
        const u = au?.user;
        results.push({
          user_id: id,
          auth_exists: !!u,
          auth_error: auErr?.message ?? null,
          auth_email: u?.email ?? null,
          auth_phone: u?.phone ?? null,
          email_confirmed: !!u?.email_confirmed_at,
          last_sign_in_at: u?.last_sign_in_at ?? null,
          has_password: !!(u as { encrypted_password?: string } | undefined)?.encrypted_password
            || (Array.isArray(u?.identities) && u!.identities!.some((i) => i.provider === "email")),
          providers: u?.app_metadata?.providers ?? null,
          profile_email: prof?.email ?? null,
          profile_phone: prof?.phone ?? null,
          full_name: prof?.full_name ?? null,
          email_matches: !!u && !!prof?.email ? u.email === prof.email : null,
        });
      }
      return new Response(JSON.stringify({ targeted: true, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Get all auth users (paginated)
    const allAuthUsers: Array<{ id: string; email?: string; phone?: string }> = [];
    let page = 1;
    while (true) {
      const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      if (!users?.length) break;
      allAuthUsers.push(...users.map(u => ({ id: u.id, email: u.email, phone: u.phone })));
      if (users.length < 1000) break;
      page++;
    }

    // Get all profiles
    const profiles: Array<{ id: string; email: string | null; phone: string | null; full_name: string | null }> = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error: profileError } = await supabaseAdmin
          .from("profiles")
          .select("id, email, phone, full_name")
          .range(from, from + pageSize - 1);
        if (profileError) throw profileError;
        if (!data?.length) break;
        profiles.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
    }

    // Find mismatches
    const mismatches: Array<{
      user_id: string;
      profile_email: string | null;
      auth_email: string | undefined;
      phone: string | null;
      full_name: string | null;
      issue: string;
    }> = [];

    const authMap = new Map(allAuthUsers.map(u => [u.id, u]));

    for (const profile of profiles || []) {
      const authUser = authMap.get(profile.id);
      if (!authUser) {
        mismatches.push({
          user_id: profile.id,
          profile_email: profile.email,
          auth_email: undefined,
          phone: profile.phone,
          full_name: profile.full_name,
          issue: "profile_exists_but_no_auth_user",
        });
        continue;
      }
      if (profile.email && authUser.email && profile.email !== authUser.email) {
        mismatches.push({
          user_id: profile.id,
          profile_email: profile.email,
          auth_email: authUser.email,
          phone: profile.phone,
          full_name: profile.full_name,
          issue: "email_mismatch",
        });
      }
    }

    return new Response(
      JSON.stringify({
        total_auth_users: allAuthUsers.length,
        total_profiles: profiles?.length ?? 0,
        mismatches_count: mismatches.length,
        mismatches: mismatches.slice(0, 100),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: any) {
    console.error("Error in diagnose-auth:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
