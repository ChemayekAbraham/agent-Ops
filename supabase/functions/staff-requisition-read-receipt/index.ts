import { createClient } from "npm:@supabase/supabase-js@2";
import { readStaffRequisitionReceipts } from "../_shared/requisitionReceiptRead.ts";

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
 * Re-read the requisition receipts already stored for this row.
 * The caller cannot supply an image. Does not move money.
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
    if (!requisitionId) return json({ error: "missing_fields" }, 400);

    const { data: row, error: rowErr } = await admin
      .from("staff_requisitions")
      .select("id, requester_id")
      .eq("id", requisitionId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) return json({ error: "not_found" }, 404);

    if (row.requester_id !== userId) {
      const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("enabled", true);
      const held = new Set((roles ?? []).map((r: { role: string }) => r.role));
      if (![...held].some((r) => APPROVER_ROLES.has(r))) return json({ error: "forbidden" }, 403);
    }

    const read = await readStaffRequisitionReceipts(admin, requisitionId, {
      apiKey: Deno.env.get("LOVABLE_API_KEY") ?? "",
      actorId: userId,
    });
    return json({
      ok: true,
      skipped: read.skipped === true,
      receipt_match_status: read.verdict.status,
      receipt_ocr_amount: read.verdict.ocrAmount,
      amount_unaccounted: read.verdict.amountUnaccounted,
      payout_frozen: read.verdict.payoutFrozen,
      message: read.verdict.message,
    });
  } catch (e) {
    console.error("staff-requisition-read-receipt error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
