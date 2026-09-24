import { createClient } from "npm:@supabase/supabase-js@2";
import { issueShareInvite } from "../_shared/shareOnboardingInvite.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Unauthorized" }, 401);
    const { data: isOps } = await admin.rpc("is_partner_ops", { _uid: user.id });
    if (!isOps) return json({ error: "Only Partner Operations can resend" }, 403);

    const { id } = await req.json().catch(() => ({}));
    if (typeof id !== "string") return json({ error: "Missing request id" }, 400);
    const { data: row } = await admin.from("share_onboarding_requests").select("*").eq("id", id).maybeSingle();
    if (!row) return json({ error: "Request not found" }, 404);
    if (row.status !== "awaiting_signature") return json({ error: "Only unsigned requests can be resent" }, 400);

    const invite = await issueShareInvite(admin, row, req.headers.get("origin") || "https://welileapp.com", String(Date.now()));
    await admin.from("audit_logs").insert({
      user_id: user.id, action_type: "share_onboarding_invite_resent", table_name: "share_onboarding_requests",
      record_id: id, reason: `Share signing link resent (${row.reference_id})`,
    });
    return json({ ok: true, emailed: invite.emailed, email: invite.email, signing_url: invite.url });
  } catch (e) {
    console.error("[resend-share-onboarding-invite]", (e as Error)?.message || e);
    return json({ error: "Could not resend. Please try again." }, 500);
  }
});
