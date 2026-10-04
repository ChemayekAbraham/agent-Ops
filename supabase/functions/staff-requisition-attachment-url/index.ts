import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APPROVER_ROLES = new Set(["cfo", "coo", "ceo", "manager", "super_admin"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Short-lived signed URL for one staff_requisitions attachment. The
 * `requisition-attachments` bucket has no read policy for regular staff
 * (only cfo/manager/super_admin), so the requester views their own upload
 * through this function rather than a widened storage RLS policy.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !userData?.user) return json({ error: "not_authenticated" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const requisitionId = String(body.requisition_id ?? "");
    const path = String(body.path ?? "");
    if (!requisitionId || !path) return json({ error: "missing_fields" }, 400);

    const { data: row, error: rowErr } = await admin
      .from("staff_requisitions")
      .select("id, requester_id, attachment_urls")
      .eq("id", requisitionId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) return json({ error: "not_found" }, 404);

    const attachments: string[] = Array.isArray(row.attachment_urls) ? row.attachment_urls : [];
    if (!attachments.includes(path)) return json({ error: "not_found" }, 404);

    if (row.requester_id !== userId) {
      const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("enabled", true);
      const held = new Set((roles ?? []).map((r: { role: string }) => r.role));
      const isApprover = [...held].some((r) => APPROVER_ROLES.has(r));
      if (!isApprover) return json({ error: "forbidden" }, 403);
    }

    const { data: signed, error: signErr } = await admin.storage
      .from("requisition-attachments")
      .createSignedUrl(path, 300);
    if (signErr) throw signErr;

    return json({ ok: true, url: signed.signedUrl });
  } catch (e) {
    console.error("staff-requisition-attachment-url error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
