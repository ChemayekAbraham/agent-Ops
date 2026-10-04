import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Lets a requester attach a receipt/supporting document to their OWN
 * staff_requisitions row after the fact — the staff flow has no upload step
 * at submission time, and there's no reason to force one; proof of spend
 * commonly only exists once the money has already been used.
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

    const form = await req.formData();
    const requisitionId = String(form.get("requisition_id") ?? "");
    const file = form.get("file");
    if (!requisitionId || !(file instanceof File)) return json({ error: "missing_fields" }, 400);
    if (!ALLOWED.has(file.type)) return json({ error: "unsupported_type" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "too_large" }, 400);

    const { data: row, error: rowErr } = await admin
      .from("staff_requisitions")
      .select("id, requester_id, requisition_code, stage, attachment_urls")
      .eq("id", requisitionId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) return json({ error: "not_found" }, 404);
    if (row.requester_id !== userId) return json({ error: "not_your_requisition" }, 403);

    const existing: string[] = Array.isArray(row.attachment_urls) ? row.attachment_urls : [];
    if (existing.length >= MAX_ATTACHMENTS) return json({ error: "attachment_limit_reached" }, 400);

    const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
    const path = `staff/${row.id}/${crypto.randomUUID()}.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { error: upErr } = await admin.storage
      .from("requisition-attachments")
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;

    const nextAttachments = [...existing, path];
    const { error: updateErr } = await admin
      .from("staff_requisitions")
      .update({ attachment_urls: nextAttachments })
      .eq("id", row.id);
    if (updateErr) throw updateErr;

    await admin.from("staff_requisition_events").insert({
      requisition_id: row.id,
      actor_id: userId,
      action: "receipt_attached",
      stage: row.stage,
      comment: file.name.slice(0, 300),
      metadata: { path },
    });

    return json({ ok: true, path, name: file.name });
  } catch (e) {
    console.error("staff-requisition-add-attachment error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
