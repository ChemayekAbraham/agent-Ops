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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "No authorization header" }, 401);

    const { data: { user }, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    const reqBody = await req.json().catch(() => ({}));
    const { subAgentId } = reqBody;
    const origin = typeof reqBody?.origin === "string" && reqBody.origin.startsWith("http")
      ? reqBody.origin.replace(/\/+$/, "")
      : "https://welileapp.com";

    if (!subAgentId || typeof subAgentId !== "string") {
      return json({ error: "Missing subAgentId" }, 400);
    }

    // Find the pending relationship where caller is the parent
    const { data: link, error: linkErr } = await adminClient
      .from("agent_subagents")
      .select("id, parent_agent_id, sub_agent_id, status, acceptance_token")
      .eq("parent_agent_id", user.id)
      .eq("sub_agent_id", subAgentId)
      .maybeSingle();

    if (linkErr) return json({ error: linkErr.message }, 500);
    if (!link) return json({ error: "No sub-agent relationship found." }, 404);
    // Allow resending invites that are still pending OR have lapsed to expired
    // (the auto-expiry job flips week-old pending invites to 'expired').
    if (link.status !== "pending_acceptance" && link.status !== "expired") {
      return json({ error: "This invite is no longer pending." }, 400);
    }

    // Regenerate a fresh acceptance token and extend expiration
    const newToken = crypto.randomUUID();
    const inviteExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: updErr } = await adminClient
      .from("agent_subagents")
      .update({ acceptance_token: newToken, expires_at: inviteExpiresAt, status: "pending_acceptance" })
      .eq("id", link.id);
    if (updErr) return json({ error: updErr.message }, 500);

    // Get profiles for both parties
    const { data: callerProfile } = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    const parentName = callerProfile?.full_name || "A Welile agent";

    const { data: targetProfile } = await adminClient
      .from("profiles")
      .select("full_name, phone, email")
      .eq("id", subAgentId)
      .maybeSingle();
    if (!targetProfile) return json({ error: "Sub-agent profile not found." }, 404);

    // Re-issue the invite. No SMS — email + in-app dialog + shareable link only.
    // Carry over the personal message stored on the link, if any.
    const { data: linkRow } = await adminClient
      .from("agent_subagents")
      .select("invite_message")
      .eq("id", link.id)
      .maybeSingle();
    const inviteMessage = (linkRow?.invite_message as string | null) ?? null;
    const acceptLink = `${origin}/sub-agent-invite?token=${newToken}`;
    let emailSent = false;

    if (targetProfile.email && !targetProfile.email.endsWith("@welile.user")) {
      try {
        const { error: emailErr } = await adminClient.functions.invoke("send-transactional-email", {
          body: {
            templateName: "sub-agent-invite",
            recipientEmail: targetProfile.email,
            idempotencyKey: `subagent-invite-resend-${newToken}`,
            templateData: {
              recipient_name: targetProfile.full_name || "there",
              parent_name: parentName,
              accept_url: acceptLink,
              invite_message: inviteMessage || "",
            },
          },
        });
        emailSent = !emailErr;
      } catch (e) {
        console.error("[resend-subagent-invite] email invoke failed:", e);
      }
    }

    return json({ ok: true, emailSent, acceptLink, name: targetProfile.full_name });
  } catch (err) {
    return json({ error: (err as Error)?.message || "Unexpected error" }, 500);
  }
});
