import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Backfill / reconciliation: for every `bulk_bank_payout_allocations` row
 * whose `status='settled'` but whose underlying `withdrawal_requests` row is
 * still in an in-flight state (pending/manager_approved/cfo_approved/
 * fin_ops_approved/processing/requested), invoke `approve-withdrawal` so the
 * WR advances to `completed` — which is what the proxy-agent UI watches for.
 *
 * Money already left Welile's bank as part of the SKYBUBBLES bulk batch;
 * this only catches up the bookkeeping (ledger + proxy_payout_settlements).
 *
 * Safe to re-run — approve-withdrawal is idempotent on already-completed
 * rows.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const IN_FLIGHT = [
      "pending",
      "requested",
      "manager_approved",
      "cfo_approved",
      "fin_ops_approved",
      "processing",
    ];

    const { data: stuck, error } = await admin
      .from("bulk_bank_payout_allocations")
      .select("id, withdrawal_request_id, metadata, gmail_transaction_id, allocated_amount")
      .eq("status", "settled");
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const wrIds = Array.from(new Set((stuck || []).map((r: any) => r.withdrawal_request_id).filter(Boolean)));
    if (wrIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: 0, reconciled: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: wrs } = await admin
      .from("withdrawal_requests")
      .select("id, status")
      .in("id", wrIds);
    const statusById = new Map<string, string>((wrs || []).map((w: any) => [w.id, w.status]));

    const reconciled: any[] = [];
    const failed: any[] = [];
    const skipped: any[] = [];

    for (const a of stuck || []) {
      const wrId = a.withdrawal_request_id;
      if (!wrId) continue;
      const s = statusById.get(wrId);
      if (!s) { skipped.push({ wrId, reason: "wr_not_found" }); continue; }
      if (!IN_FLIGHT.includes(s)) { skipped.push({ wrId, reason: `wr_status_${s}` }); continue; }

      const ref = (a.metadata?.reference || a.metadata?.email_tid || a.gmail_transaction_id || `BULK-${wrId.slice(0, 8)}`).toString();

      const resp = await fetch(`${supabaseUrl}/functions/v1/approve-withdrawal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          system_caller: true,
          withdrawal_id: wrId,
          reference: ref,
          payment_method: "bank_transfer",
        }),
      });

      const txt = await resp.text().catch(() => "");
      let parsed: any = null;
      try { parsed = JSON.parse(txt); } catch (_) { /* keep raw */ }
      const innerOk = resp.ok && parsed && parsed.success !== false;
      if (!innerOk) {
        failed.push({ wrId, http: resp.status, body: parsed ?? txt.slice(0, 400) });
        continue;
      }
      reconciled.push({ wrId, reference: ref });

      try {
        await admin.from("audit_logs").insert({
          action_type: "withdrawal_bulk_reconciled",
          table_name: "withdrawal_requests",
          record_id: wrId,
          reason: `Reconciled stuck SKYBUBBLES bulk allocation ${a.id.slice(0, 10)}`,
          metadata: { allocation_id: a.id, reference: ref, prior_wr_status: s },
        });
      } catch (_) { /* non-fatal */ }
    }

    return new Response(JSON.stringify({
      ok: true,
      checked: stuck?.length || 0,
      reconciled: reconciled.length,
      failed: failed.length,
      skipped: skipped.length,
      details: { reconciled, failed, skipped },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "unexpected" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});