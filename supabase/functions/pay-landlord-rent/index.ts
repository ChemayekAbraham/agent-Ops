import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DueRow {
  id: string;
  tenant_id: string;
  landlord_id: string;
  rent_amount: number;
  landlord_payout_day: number;
  landlord_payout_next_run_at: string;
}

function advanceOneMonth(from: Date, day: number): Date {
  // Move to next month, same day-of-month (clamped to 28 by the trigger).
  const d = new Date(from);
  d.setUTCDate(1); // avoid month-end overflow
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(Math.min(Math.max(day, 1), 28));
  d.setUTCHours(7, 0, 0, 0);
  return d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const nowIso = new Date().toISOString();
    const { data: due, error: dueErr } = await supabase
      .from("rent_requests")
      .select("id, tenant_id, landlord_id, rent_amount, landlord_payout_day, landlord_payout_next_run_at")
      .eq("landlord_payout_enabled", true)
      .not("landlord_payout_day", "is", null)
      .not("landlord_payout_next_run_at", "is", null)
      .lte("landlord_payout_next_run_at", nowIso)
      .in("status", ["approved", "disbursed", "active"])
      .limit(500);

    if (dueErr) throw dueErr;

    const results: Array<Record<string, unknown>> = [];
    let processed = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of (due ?? []) as DueRow[]) {
      const amount = Number(row.rent_amount);
      if (!amount || amount <= 0) {
        skipped++;
        results.push({ id: row.id, skipped: "zero_amount" });
        continue;
      }

      const period = new Date(row.landlord_payout_next_run_at).toISOString().slice(0, 7); // YYYY-MM
      const idempotencyKey = `landlord_rent:${row.id}:${period}`;

      const entries = [
        {
          ledger_scope: "platform",
          direction: "cash_out",
          category: "rent_disbursement",
          amount,
          description: `Welile-funded landlord rent payout for ${period}`,
          source_table: "rent_requests",
          source_id: row.id,
          reference_id: idempotencyKey,
          linked_party: row.landlord_id,
        },
        {
          ledger_scope: "wallet",
          direction: "cash_in",
          category: "landlord_rent_payment",
          amount,
          description: `Monthly rent for ${period} (auto)`,
          source_table: "rent_requests",
          source_id: row.id,
          reference_id: idempotencyKey,
          user_id: row.landlord_id,
          recipient_type: "user",
          linked_party: row.tenant_id,
        },
      ];

      const { error: ledgerErr } = await supabase.rpc("create_ledger_transaction", {
        entries,
        idempotency_key: idempotencyKey,
      } as never);

      if (ledgerErr) {
        failed++;
        await supabase.from("system_events").insert({
          event_type: "landlord.rent_payout.failed",
          aggregate_type: "rent_request",
          aggregate_id: row.id,
          payload: {
            rent_request_id: row.id,
            landlord_id: row.landlord_id,
            amount,
            period,
            error: ledgerErr.message,
          },
        });
        results.push({ id: row.id, error: ledgerErr.message });
        continue;
      }

      const nextRun = advanceOneMonth(
        new Date(row.landlord_payout_next_run_at),
        row.landlord_payout_day
      );

      await supabase
        .from("rent_requests")
        .update({
          landlord_payout_last_run_at: nowIso,
          landlord_payout_next_run_at: nextRun.toISOString(),
        })
        .eq("id", row.id);

      await supabase.from("system_events").insert({
        event_type: "landlord.rent_payout.completed",
        aggregate_type: "rent_request",
        aggregate_id: row.id,
        payload: {
          rent_request_id: row.id,
          landlord_id: row.landlord_id,
          tenant_id: row.tenant_id,
          amount,
          period,
          next_run_at: nextRun.toISOString(),
        },
      });

      await supabase.from("audit_logs").insert({
        action_type: "landlord_rent_payout",
        table_name: "rent_requests",
        record_id: row.id,
        reason: "auto-landlord-monthly-payout",
        metadata: { amount, period, landlord_id: row.landlord_id },
      });

      // Trust signals (non-blocking)
      await supabase.rpc("capture_trust_signal", {
        p_user_id: row.landlord_id,
        p_signal_type: "rent_received",
        p_metadata: { rent_request_id: row.id, amount, period },
      } as never).catch(() => {});
      await supabase.rpc("capture_trust_signal", {
        p_user_id: row.tenant_id,
        p_signal_type: "rent_obligation_serviced",
        p_metadata: { rent_request_id: row.id, amount, period },
      } as never).catch(() => {});

      processed++;
      results.push({ id: row.id, paid: amount, next_run_at: nextRun.toISOString() });
    }

    return new Response(
      JSON.stringify({ success: true, processed, failed, skipped, total: due?.length ?? 0, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[pay-landlord-rent] fatal:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});