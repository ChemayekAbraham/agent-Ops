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

    // 1. Verify caller is authenticated (supports service-role key or user JWT)
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "") ?? "";
    const isServiceRole = token === supabaseServiceKey;

    let callerId = "service-role";
    if (!isServiceRole) {
      if (!token) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
      const user = authData?.user;

      if (authError || !user) {
        console.error("Auth validation failed:", authError?.message ?? "No user found");
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      callerId = user.id;
    }

    // 2. Verify caller has an authorised admin role (skip for service-role)
    // Allowed roles mirror the routes that surface the Reset Password UI:
    //   /platform-users (manager, cto), /users (super_admin, manager, cto),
    //   HR User Management (hr -> stored as 'employee' with hr permissions),
    //   plus executive roles that legitimately manage staff accounts.
    const ADMIN_RESET_ROLES = [
      "manager",
      "cto",
      "super_admin",
      "ceo",
      "coo",
      "cfo",
      "cmo",
      "operations",
    ];

    if (!isServiceRole) {
      const { data: roleRows, error: roleError } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", callerId)
        .eq("enabled", true)
        .in("role", ADMIN_RESET_ROLES);

      if (roleError) {
        console.error("Role lookup failed:", roleError.message);
        return new Response(JSON.stringify({ error: "Authorisation check failed" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!roleRows || roleRows.length === 0) {
        return new Response(
          JSON.stringify({ error: "You do not have permission to reset passwords" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // 3. Validate input
    const { user_id, new_password } = await req.json();

    if (!user_id || !new_password) {
      throw new Error("user_id and new_password are required");
    }

    // Validate user_id is a valid UUID
    if (typeof user_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)) {
      throw new Error("Invalid user ID format");
    }

    if (typeof new_password !== "string" || new_password.length < 6 || new_password.length > 128) {
      throw new Error("Password must be 6-128 characters");
    }

    // 4. Reset the password
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
      user_id,
      {
        password: new_password,
        // A manager-issued reset should leave the account immediately usable.
        // If the user's login email was never confirmed, password auth remains
        // blocked even though the password itself changed successfully.
        email_confirm: true,
      }
    );

    if (error) {
      throw error;
    }

    // Permanent, actor-attributed record. Previously this action was only a
    // console.log line -- not queryable, and never captured WHO performed
    // the reset (only the target user_id reached the database, via the
    // auth.users trigger, and with no IP since this call never goes through
    // PostgREST). Captured here because this edge function is the only
    // place in the whole call path that has the real client IP.
    const clientIp =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      null;
    const userAgent = req.headers.get("user-agent") || null;

    try {
      await supabaseAdmin.from("audit_logs").insert({
        user_id: callerId === "service-role" ? null : callerId,
        action_type: "admin_password_reset",
        table_name: "auth.users",
        record_id: user_id,
        ip_address: clientIp,
        user_agent: userAgent,
        metadata: {
          target_user_id: user_id,
          performed_by: callerId,
        },
      });
    } catch (auditErr) {
      // Telemetry must never block a password reset that already succeeded.
      console.error("admin-reset-password: audit insert failed:", auditErr);
    }

    console.log(`Password reset by ${callerId} for user: ${user_id}`);

    return new Response(
      JSON.stringify({ success: true, message: "Password reset successfully" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error: any) {
    console.error("Error resetting password:", error);
    const isWeak = error?.code === "weak_password" || /weak|pwned|known to be/i.test(error?.message ?? "");
    const message = isWeak
      ? "This password has appeared in a known data breach. Please choose a stronger, unique password (mix of letters, numbers, and symbols)."
      : error.message;
    return new Response(
      JSON.stringify({ error: message, code: error?.code ?? null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: isWeak ? 422 : 400 }
    );
  }
});
