import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateFullName, FULL_NAME_ERROR } from "../_shared/validateFullName.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller is staff
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user: caller } } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Check caller has admin role
    const { data: callerRoles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .in("role", ["super_admin", "manager", "cto", "hr"]);

    if (!callerRoles || callerRoles.length === 0) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      email,
      password,
      full_name,
      phone,
      department,
      position,
      role,
      employee_id,
      created_by,
    } = body;

    // Validate
    if (!email || !password || !phone || !employee_id) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const nameCheck = validateFullName(full_name);
    if (!nameCheck.valid) {
      return new Response(JSON.stringify({ error: nameCheck.error || FULL_NAME_ERROR }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const cleanFullName = nameCheck.trimmed;

    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check employee_id uniqueness
    const { data: existingEmp } = await adminClient
      .from("staff_profiles")
      .select("employee_id")
      .eq("employee_id", employee_id)
      .maybeSingle();

    if (existingEmp) {
      return new Response(JSON.stringify({ error: "Employee ID already exists" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create auth user
    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: cleanFullName, phone },
    });

    if (authError) {
      return new Response(JSON.stringify({ error: authError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = authData.user.id;

    // Create profile (upsert in case trigger already created it)
    await adminClient.from("profiles").upsert({
      id: userId,
      full_name: cleanFullName,
      email,
      phone,
      verified: true,
    }, { onConflict: "id" });

    // Assign role
    const staffRole = role || "employee";
    await adminClient.from("user_roles").insert({
      user_id: userId,
      role: staffRole,
      enabled: true,
    });

    // Create staff profile
    await adminClient.from("staff_profiles").insert({
      user_id: userId,
      employee_id,
      department: department || "General",
      position: position || "Staff",
      must_change_password: true,
      created_by: created_by || caller.id,
    });


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceRoleKey}` },
      body: JSON.stringify({ title: "👤 Employee Registered", body: "Activity: new employee", url: "/dashboard/manager" }),
    }).catch(() => {});

    // Permanent, actor-attributed record. This action creates a staff auth
    // account with an assigned role -- previously it had no audit trail at
    // all beyond a fire-and-forget manager notification, and never recorded
    // WHO performed it. Same pattern as admin-reset-password: this edge
    // function has the real client IP on its own incoming request.
    const clientIp =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      null;
    const userAgent = req.headers.get("user-agent") || null;

    try {
      await adminClient.from("audit_logs").insert({
        user_id: caller.id,
        action_type: "staff_account_created",
        table_name: "staff_profiles",
        record_id: userId,
        ip_address: clientIp,
        user_agent: userAgent,
        metadata: {
          target_user_id: userId,
          created_by: created_by || caller.id,
          role_assigned: staffRole,
          employee_id,
          department: department || "General",
          position: position || "Staff",
        },
      });
    } catch (auditErr) {
      // Telemetry must never block a staff account that already exists.
      console.error("register-employee: audit insert failed:", auditErr);
    }


    return new Response(
      JSON.stringify({ success: true, user_id: userId, employee_id }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("register-employee error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
