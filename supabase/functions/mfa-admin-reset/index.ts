// Admin reset of a staff member's authenticator factor (lost or replaced phone).
// Doc 249 / docs/security/mfa-enforcement-design.md section 4.4.
//
// Only a super_admin may call this, never for their own account (a super_admin's own reset needs
// ANOTHER super_admin). Confirm the person's identity by phone call or in person first, never by
// email alone. Every reset is written to audit_logs. After a reset the person re-enrols at next sign-in.
import { createClient } from "npm:@supabase/supabase-js@2";
import { requireStaffAal2 } from "../_shared/staffMfa.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!token) return json({ error: "unauthenticated" }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    const caller = userData?.user;
    if (userErr || !caller) return json({ error: "unauthenticated" }, 401);

    const { data: roleRow } = await admin
      .from("user_roles").select("role").eq("user_id", caller.id).eq("role", "super_admin").eq("enabled", true).maybeSingle();
    if (!roleRow) return json({ error: "not_authorized" }, 403);

    const gate = await requireStaffAal2(admin, token, caller.id);
    if (!gate.ok) return json(gate.body, gate.status);

    const body = await req.json().catch(() => ({}));
    const targetId = String(body?.target_user_id ?? "");
    const reason = String(body?.reason ?? "").trim();
    if (!UUID_RE.test(targetId)) return json({ error: "invalid_target_user_id" }, 400);
    if (reason.length < 10) return json({ error: "reason_required", message: "Give a reason of at least 10 characters (who confirmed the person's identity and how)." }, 400);
    if (targetId === caller.id) return json({ error: "cannot_reset_own_factor", message: "Ask another super_admin." }, 403);

    const { data: list, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId: targetId });
    if (listErr) return json({ error: "list_failed", message: listErr.message }, 500);
    const factors = list?.factors ?? [];
    let removed = 0;
    for (const f of factors) {
      const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: targetId });
      if (delErr) return json({ error: "delete_failed", message: delErr.message, removed }, 500);
      removed += 1;
    }

    await admin.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "mfa_factor_reset",
      action: "Reset a staff member's authenticator",
      table_name: "auth.mfa_factors",
      record_id: targetId,
      reason,
      metadata: { factors_removed: removed },
    });

    return json({ success: true, factors_removed: removed });
  } catch (err) {
    console.error("[mfa-admin-reset] failed:", err);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
