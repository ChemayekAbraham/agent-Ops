import "../_shared/noSignupPrompt.ts";
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

    // Auth: verify caller is manager/cto/super_admin via JWT.
    // The Authorization header is mandatory — no unauthenticated bypass.
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "").trim() ?? "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let callerId = "service-role";
    const isServiceRole = token === supabaseServiceKey;
    if (!isServiceRole) {
      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
      if (authError || !authData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      callerId = authData.user.id;
      const { data: roleData } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", callerId)
        .eq("enabled", true)
        .in("role", ["manager", "cto", "super_admin"]);
      if (!roleData?.length) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body = await req.json();
    const { user_ids, new_password, scope } = body;

    if (!new_password || typeof new_password !== "string" || new_password.length < 6) {
      return new Response(JSON.stringify({ error: "new_password must be at least 6 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let targetUserIds: string[] = [];

    if (scope === "all_non_staff") {
      const { data: staffRoles } = await supabaseAdmin
        .from("user_roles")
        .select("user_id")
        .eq("enabled", true)
        .in("role", ["manager", "cto", "ceo", "cfo", "coo", "cmo", "super_admin"]);
      const staffIds = new Set((staffRoles || []).map(r => r.user_id));

      let page = 1;
      while (true) {
        const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        if (!users?.length) break;
        for (const u of users) {
          if (!staffIds.has(u.id)) targetUserIds.push(u.id);
        }
        if (users.length < 1000) break;
        page++;
      }
    } else if (user_ids?.length) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      targetUserIds = user_ids.filter((id: string) => uuidRegex.test(id));
    } else {
      return new Response(JSON.stringify({ error: "Provide user_ids array or scope='all_non_staff'" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = { success: 0, failed: 0, errors: [] as string[] };

    for (let i = 0; i < targetUserIds.length; i++) {
      try {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(
          targetUserIds[i],
          {
            password: new_password,
            email_confirm: true,
          }
        );
        if (error) {
          results.failed++;
          if (results.errors.length < 20) results.errors.push(`${targetUserIds[i]}: ${error.message}`);
        } else {
          results.success++;
        }
      } catch (e: any) {
        results.failed++;
        if (results.errors.length < 20) results.errors.push(`${targetUserIds[i]}: ${e.message}`);
      }

      if ((i + 1) % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`[bulk-password-reset] by=${callerId} total=${targetUserIds.length} success=${results.success} failed=${results.failed}`);

    await supabaseAdmin.from("audit_logs").insert({
      action_type: "bulk_password_reset",
      user_id: callerId === "service-role" ? null : callerId,
      metadata: {
        total: targetUserIds.length,
        success: results.success,
        failed: results.failed,
        scope: scope || "user_ids",
      },
    });

    return new Response(
      JSON.stringify({
        total_targeted: targetUserIds.length,
        success: results.success,
        failed: results.failed,
        errors: results.errors,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: any) {
    console.error("Error in bulk-password-reset:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
