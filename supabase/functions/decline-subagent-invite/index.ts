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
    if (!token) return json({ error: "Please sign in to respond to this invitation." }, 401);

    const { data: { user }, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !user) return json({ error: "Please sign in to respond to this invitation." }, 401);

    const { acceptanceToken } = await req.json().catch(() => ({}));
    if (!acceptanceToken || typeof acceptanceToken !== "string") {
      return json({ error: "Invalid invitation link." }, 400);
    }

    const { data: link, error: linkErr } = await adminClient
      .from("agent_subagents")
      .select("id, sub_agent_id, status")
      .eq("acceptance_token", acceptanceToken)
      .maybeSingle();

    if (linkErr) return json({ error: linkErr.message }, 500);
    if (!link) return json({ error: "This invitation is no longer valid." }, 404);

    // Only the invited user may decline.
    if (link.sub_agent_id !== user.id) {
      return json({ error: "This invitation was sent to a different account." }, 403);
    }

    if (link.status === "verified") {
      return json({ error: "You have already accepted this invitation." }, 400);
    }

    const { error: updErr } = await adminClient
      .from("agent_subagents")
      .update({
        status: "rejected",
        rejection_reason: "Declined by the invited user",
        acceptance_token: null,
        expires_at: null,
      })
      .eq("id", link.id);
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, declined: true });
  } catch (err) {
    return json({ error: (err as Error)?.message || "Unexpected error" }, 500);
  }
});