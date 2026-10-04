import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    // --- Auth: only CTO / super_admin / manager may resend ---
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["cto", "super_admin", "manager"]);
    if (!roles || roles.length === 0) {
      return json({ error: "Insufficient permissions" }, 403);
    }

    // --- Input ---
    let logId: string | undefined;
    let force = false;
    try {
      const body = await req.json();
      logId = body.id || body.logId;
      force = body.force === true;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!logId) return json({ error: "id is required" }, 400);

    // --- Locate the original email log row ---
    const { data: row, error: rowErr } = await adminClient
      .from("email_send_log")
      .select("id, template_name, recipient_email, metadata, status")
      .eq("id", logId)
      .maybeSingle();
    if (rowErr) return json({ error: rowErr.message }, 500);
    if (!row) return json({ error: "Email log entry not found" }, 404);

    const templateName: string | null = row.template_name;
    const recipient: string | null = row.recipient_email;
    const templateData = (row.metadata as Record<string, unknown> | null)?.template_data as
      | Record<string, unknown>
      | undefined;

    if (!templateName) {
      return json({ error: "Original email has no template — cannot resend." }, 422);
    }
    if (!recipient) {
      return json({ error: "Original email has no recipient — cannot resend." }, 422);
    }
    if (!templateData || typeof templateData !== "object") {
      return json({
        error:
          "This email was sent without archived content, so it can't be reconstructed for resend.",
      }, 422);
    }

    // --- Optional: lift suppression so a force-resend can actually deliver ---
    if (force && recipient) {
      await adminClient
        .from("suppressed_emails")
        .delete()
        .eq("email", recipient.toLowerCase());
      await adminClient
        .from("email_unsubscribe_tokens")
        .update({ used_at: null })
        .eq("email", recipient.toLowerCase());
    }

    // --- Re-invoke the standard transactional sender (handles render + queue) ---
    const sendRes = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        templateName,
        recipientEmail: recipient,
        templateData,
      }),
    });
    const sendJson = await sendRes.json().catch(() => ({}));

    if (!sendRes.ok) {
      return json({ error: sendJson?.error || "Failed to resend email" }, 502);
    }

    if (sendJson?.reason === "email_suppressed") {
      return json({
        success: false,
        suppressed: true,
        message:
          "This address is blocked (previous bounce/unsubscribe). Use Force resend to override.",
      }, 200);
    }

    return json({ success: true, queued: sendJson?.queued === true, recipient }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}