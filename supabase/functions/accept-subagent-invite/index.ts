import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Please sign in to accept this invitation." }, 401);

    const { data: { user }, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !user) return json({ error: "Please sign in to accept this invitation." }, 401);

    const { acceptanceToken } = await req.json().catch(() => ({}));
    if (!acceptanceToken || typeof acceptanceToken !== "string") {
      return json({ error: "Invalid invitation link." }, 400);
    }

    // Look up the invite by its acceptance token.
    const { data: link, error: linkErr } = await adminClient
      .from("agent_subagents")
      .select("id, parent_agent_id, sub_agent_id, status")
      .eq("acceptance_token", acceptanceToken)
      .maybeSingle();

    if (linkErr) return json({ error: linkErr.message }, 500);
    if (!link) return json({ error: "This invitation is no longer valid." }, 404);

    // Only the invited user can accept.
    if (link.sub_agent_id !== user.id) {
      return json({ error: "This invitation was sent to a different account. Please sign in with the invited account." }, 403);
    }

    // Parent agent name for the response.
    const { data: parentProfile } = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("id", link.parent_agent_id)
      .maybeSingle();
    const parentName = parentProfile?.full_name || "your agent";

    if (link.status === "verified") {
      return json({ ok: true, alreadyAccepted: true, parentName });
    }

    // Enforce the single-parent rule: a user can only be a VERIFIED sub-agent
    // of ONE agent at a time. If they already accepted another agent's invite,
    // block accepting this one and tell them clearly who they belong to.
    const { data: existingVerified } = await adminClient
      .from("agent_subagents")
      .select("parent_agent_id")
      .eq("sub_agent_id", user.id)
      .eq("status", "verified")
      .neq("parent_agent_id", link.parent_agent_id)
      .limit(1)
      .maybeSingle();
    if (existingVerified?.parent_agent_id) {
      const { data: currentParent } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("id", existingVerified.parent_agent_id)
        .maybeSingle();
      const currentName = currentParent?.full_name || "another agent";
      return json(
        {
          error: `You are already a sub-agent of ${currentName}. You can only be a sub-agent of one agent at a time.`,
          alreadySubAgent: true,
          currentParentName: currentName,
        },
        409,
      );
    }

    // Ensure the accepting user holds the agent role (idempotent).
    const { data: existingRole } = await adminClient
      .from("user_roles")
      .select("id, enabled")
      .eq("user_id", user.id)
      .eq("role", "agent")
      .maybeSingle();
    if (!existingRole) {
      await adminClient.from("user_roles").insert({ user_id: user.id, role: "agent", enabled: true });
    } else if (existingRole.enabled === false) {
      await adminClient.from("user_roles").update({ enabled: true }).eq("id", existingRole.id);
    }

    // Accept: flip to verified (this fires the commission-award trigger).
    const nowIso = new Date().toISOString();
    const { error: updErr } = await adminClient
      .from("agent_subagents")
      .update({
        status: "verified",
        verified_by: user.id,
        verified_at: nowIso,
        accepted_at: nowIso,
        expires_at: null,
      })
      .eq("id", link.id);
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, accepted: true, parentName });
  } catch (err) {
    return json({ error: (err as Error)?.message || "Unexpected error" }, 500);
  }
});
