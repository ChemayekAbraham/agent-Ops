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
    if (!authHeader) throw new Error("Missing authorization");

    // Anon client for auth verification
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) throw new Error("Unauthorized");

    // Service client for data operations
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Check caller is manager/admin/coo/operations
    const { data: roles } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const allowedRoles = ["manager", "super_admin", "coo", "operations"];
    const hasPermission = (roles || []).some((r: any) => allowedRoles.includes(r.role));
    if (!hasPermission) throw new Error("Insufficient permissions");

    const {
      tenant_id,
      from_agent_id,
      to_agent_id,
      reason,
      flag_type,
      actor_latitude,
      actor_longitude,
      actor_accuracy,
      actor_location_status,
    } = await req.json();

    // Validate inputs
    if (!tenant_id || !from_agent_id || !to_agent_id || !reason) {
      throw new Error("Missing required fields: tenant_id, from_agent_id, to_agent_id, reason");
    }
    if (reason.length < 10) throw new Error("Reason must be at least 10 characters");
    if (from_agent_id === to_agent_id) throw new Error("Source and target agent cannot be the same");

    // Verify to_agent_id is actually an agent
    const { data: toAgentRole } = await serviceClient
      .from("user_roles")
      .select("id")
      .eq("user_id", to_agent_id)
      .eq("role", "agent")
      .maybeSingle();
    if (!toAgentRole) throw new Error("Target user is not an agent");

    // 1. Hand every non-terminal plan (and completed ones, which are what renewals
    //    are filed from) to the new agent, and stamp assigned_agent_id so the new
    //    agent is the effective manager everywhere.
    const { data: updatedRR } = await serviceClient
      .from("rent_requests")
      .update({ agent_id: to_agent_id, assigned_agent_id: to_agent_id })
      .eq("tenant_id", tenant_id)
      .eq("agent_id", from_agent_id)
      .in("status", [
        "pending",
        "approved",
        "coo_approved",
        "funded",
        "repaying",
        "active",
        "completed",
      ])
      .select("id");

    const rrCount = updatedRR?.length || 0;

    // 2. Update active subscription_charges
    const { data: updatedSC } = await serviceClient
      .from("subscription_charges")
      .update({ agent_id: to_agent_id })
      .eq("tenant_id", tenant_id)
      .eq("agent_id", from_agent_id)
      .eq("status", "active")
      .select("id");

    const scCount = updatedSC?.length || 0;

    // 3. Record transfer in audit table
    const { error: insertErr } = await serviceClient
      .from("tenant_transfers")
      .insert({
        tenant_id,
        from_agent_id,
        to_agent_id,
        transferred_by: user.id,
        reason,
        flag_type: flag_type || "manual",
        rent_requests_updated: rrCount,
        subscriptions_updated: scCount,
        actor_latitude: actor_latitude ?? null,
        actor_longitude: actor_longitude ?? null,
        actor_accuracy: actor_accuracy ?? null,
        actor_location_status: actor_location_status ?? null,
      });
    if (insertErr) throw new Error(`Failed to log transfer: ${insertErr.message}`);

    // 4. Record audit log
    await serviceClient.from("audit_logs").insert({
      user_id: user.id,
      action_type: "tenant_transfer",
      table_name: "tenant_transfers",
      metadata: {
        tenant_id,
        from_agent_id,
        to_agent_id,
        reason,
        flag_type,
        rent_requests_updated: rrCount,
        subscriptions_updated: scCount,
        actor_latitude: actor_latitude ?? null,
        actor_longitude: actor_longitude ?? null,
        actor_accuracy: actor_accuracy ?? null,
        actor_location_status: actor_location_status ?? null,
      },
    });

    // 5. Notify both agents and tenant
    const notifications = [
      { user_id: to_agent_id, title: "New Tenant Assigned", message: `A tenant has been transferred to you. ${rrCount} rent request(s) reassigned.`, type: "system" },
      { user_id: from_agent_id, title: "Tenant Reassigned", message: `A tenant has been reassigned to another agent. Reason: ${reason}`, type: "system" },
      { user_id: tenant_id, title: "Agent Updated", message: `Your servicing agent has been updated. Your new agent will be in touch.`, type: "system" },
    ];
    await serviceClient.from("notifications").insert(notifications);


    // Notify managers (fire-and-forget)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "🔄 Tenant Transferred", body: "Activity: tenant transfer", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(
      JSON.stringify({
        success: true,
        rent_requests_updated: rrCount,
        subscriptions_updated: scCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
