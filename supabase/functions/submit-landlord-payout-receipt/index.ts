// Submit landlord payout receipt: validates receipt #, marks payout completed,
// updates the per-tenant allocation, emits trust signal.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const agentId = u.user.id;

    const body = (await req.json().catch(() => ({}))) ?? {};
    const { payout_id, receipt_number, receipt_image_url } = body;

    if (!payout_id || typeof payout_id !== "string") {
      return json({ error: "payout_id required" }, 400);
    }
    if (!receipt_number || typeof receipt_number !== "string" || receipt_number.trim().length < 6) {
      return json({ error: "MoMo TID must be at least 6 characters" }, 400);
    }
    if (!receipt_image_url || typeof receipt_image_url !== "string") {
      return json({ error: "Receipt image is required" }, 400);
    }

    // Fetch payout and verify ownership + state
    const { data: payout, error: pErr } = await admin
      .from("landlord_payouts")
      .select("id, agent_id, status, amount, rent_request_id, tenant_id, landlord_name")
      .eq("id", payout_id)
      .maybeSingle();
    if (pErr || !payout) return json({ error: "Payout not found" }, 404);
    if (payout.agent_id !== agentId) return json({ error: "Forbidden" }, 403);
    if (payout.status !== "awaiting_agent_receipt") {
      return json({ error: `Payout is in status '${payout.status}', cannot upload receipt` }, 400);
    }

    // Mark completed (trigger trg_landlord_payout_to_allocation will update allocation)
    const { error: updErr } = await admin
      .from("landlord_payouts")
      .update({
        status: "completed",
        receipt_number: receipt_number.trim(),
        receipt_image_url: receipt_image_url,
        receipt_uploaded_at: new Date().toISOString(),
      })
      .eq("id", payout_id)
      .eq("status", "awaiting_agent_receipt");

    if (updErr) return json({ error: updErr.message }, 400);

    await logSystemEvent(
      admin,
      "landlord_payout_receipt_uploaded",
      agentId,
      "landlord_payout",
      payout_id,
      { amount: payout.amount, receipt_number: receipt_number.trim() },
    );

    // Capture trust signal (best-effort)
    try {
      await admin.rpc("capture_trust_signal" as any, {
        p_user_id: agentId,
        p_signal_type: "landlord_receipt_filed",
        p_weight: 1,
        p_metadata: { payout_id, amount: payout.amount },
      });
    } catch { /* non-blocking */ }

    return json({ ok: true, payout_id, status: "completed" });
  } catch (e) {
    console.error("[submit-landlord-payout-receipt] error", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});