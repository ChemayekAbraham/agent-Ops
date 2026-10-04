import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Welile Technologies platform user that owns the platform-side ledger leg
// for payroll loyalty bonuses. Same convention used by other CFO/system flows.
const PLATFORM_USER_ID = Deno.env.get("PLATFORM_USER_ID") ||
  "00000000-0000-0000-0000-000000000000";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Find a real platform user to own the cash_out leg if env not set:
    // pick any CFO if the placeholder is used.
    let platformUserId = PLATFORM_USER_ID;
    if (platformUserId === "00000000-0000-0000-0000-000000000000") {
      const { data: cfo } = await admin
        .from("user_roles")
        .select("user_id")
        .eq("role", "cfo")
        .limit(1)
        .maybeSingle();
      if (cfo?.user_id) platformUserId = cfo.user_id;
    }

    // Idempotency: only act on rows that haven't grown in the last 23h.
    const cutoff = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();

    const { data: rows, error: fetchErr } = await admin
      .from("payroll_growth_balances")
      .select("id, user_id, current_balance, accrued_growth, daily_rate, source_reference_id")
      .eq("status", "active")
      .gt("current_balance", 0)
      .lte("last_growth_at", cutoff)
      .limit(5000);

    if (fetchErr) throw fetchErr;

    let applied = 0;
    let skipped = 0;
    let totalGrowth = 0;
    const errors: Array<{ id: string; error: string }> = [];

    for (const r of rows || []) {
      const balance = Number(r.current_balance || 0);
      const rate = Number(r.daily_rate || 0.005);
      const growth = Math.round(balance * rate); // UGX whole numbers
      if (growth <= 0) { skipped++; continue; }

      const refId = `PGB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const nowIso = new Date().toISOString();

      const { error: ledErr } = await admin.rpc("create_ledger_transaction", {
        entries: [
          {
            user_id: r.user_id,
            amount: growth,
            direction: "cash_in",
            category: "system_balance_correction",
            ledger_scope: "wallet",
            source_table: "payroll_growth_balances",
            reference_id: refId,
            description: `Payroll loyalty bonus 0.5%/day [src=${r.source_reference_id || r.id}]`,
            currency: "UGX",
            transaction_date: nowIso,
          },
          {
            user_id: platformUserId,
            amount: growth,
            direction: "cash_out",
            category: "interest_expense",
            ledger_scope: "platform",
            source_table: "payroll_growth_balances",
            reference_id: refId,
            description: `Payroll loyalty bonus 0.5%/day → user ${r.user_id} [src=${r.source_reference_id || r.id}]`,
            currency: "UGX",
            transaction_date: nowIso,
          },
        ],
        skip_balance_check: true,
      });

      if (ledErr) {
        errors.push({ id: r.id, error: ledErr.message });
        continue;
      }

      // Route the credit to withdrawable bucket (recipient is a user)
      try {
        await admin.rpc("enforce_recipient_routing", {
          p_user_id: r.user_id,
          p_amount: growth,
          p_recipient_type: "user",
        });
      } catch (e) {
        console.warn("[apply-payroll-growth] enforce_recipient_routing failed:", e);
      }

      const { error: upErr } = await admin
        .from("payroll_growth_balances")
        .update({
          current_balance: balance + growth,
          accrued_growth: Number(r.accrued_growth || 0) + growth,
          last_growth_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", r.id);

      if (upErr) {
        errors.push({ id: r.id, error: upErr.message });
        continue;
      }

      // Trust mission: emit a system_event for observability
      try {
        await admin.from("system_events").insert({
          event_type: "payroll.growth.applied",
          user_id: r.user_id,
          related_entity_type: "payroll_growth_balances",
          related_entity_id: r.id,
          metadata: {
            tracker_id: r.id,
            growth,
            new_balance: balance + growth,
            rate,
            reference_id: refId,
          },
        });
      } catch (_e) { /* non-fatal */ }

      applied++;
      totalGrowth += growth;
    }

    const summary = { applied, skipped, totalGrowth, errors, ranAt: new Date().toISOString() };
    console.log("[apply-payroll-growth] summary:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("apply-payroll-growth error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});