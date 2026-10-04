import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user: caller } } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: callerRoles } = await adminClient
      .from("user_roles").select("role").eq("user_id", caller.id)
      .in("role", ["hr", "super_admin", "cto"]);

    if (!callerRoles || callerRoles.length === 0) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { leave_request_id, status, review_note } = await req.json();

    if (!leave_request_id || !status || !review_note) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (review_note.length < 10) {
      return new Response(JSON.stringify({ error: "Review note must be at least 10 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["approved", "rejected"].includes(status)) {
      return new Response(JSON.stringify({ error: "Status must be approved or rejected" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update leave request
    const { error: updateError } = await adminClient
      .from("leave_requests")
      .update({
        status,
        reviewed_by: caller.id,
        reviewed_at: new Date().toISOString(),
        review_note,
      })
      .eq("id", leave_request_id);

    if (updateError) throw updateError;

    // If approved, decrement leave balance
    if (status === "approved") {
      const { data: request } = await adminClient
        .from("leave_requests")
        .select("employee_id, leave_type, days_count")
        .eq("id", leave_request_id)
        .single();

      if (request) {
        const year = new Date().getFullYear();
        const { data: balance } = await adminClient
          .from("leave_balances")
          .select("*")
          .eq("employee_id", request.employee_id)
          .eq("leave_type", request.leave_type)
          .eq("year", year)
          .single();

        if (balance) {
          await adminClient.from("leave_balances").update({
            used_days: balance.used_days + request.days_count,
            remaining_days: balance.remaining_days - request.days_count,
            updated_at: new Date().toISOString(),
          }).eq("id", balance.id);
        }
      }
    }

    // Audit log (trigger handles this, but edge function logs explicitly too)
    await adminClient.from("audit_logs").insert({
      user_id: caller.id,
      action_type: status === "approved" ? "hr_leave_approved" : "hr_leave_rejected",
      metadata: { leave_request_id, status, review_note },
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("hr-approve-leave error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
