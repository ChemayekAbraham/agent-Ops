import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Fetch all active recovery cases
    const { data: cases, error: fetchErr } = await admin
      .from("debt_recovery_cases")
      .select("*")
      .eq("status", "active");

    if (fetchErr) {
      console.error("[process-debt-recovery] Fetch error:", fetchErr);
      return new Response(JSON.stringify({ error: "Failed to fetch cases" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!cases || cases.length === 0) {
      return new Response(JSON.stringify({ processed: 0, message: "No active cases" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: any[] = [];

    for (const recoveryCase of cases) {
      try {
        const remaining = Number(recoveryCase.original_amount) - Number(recoveryCase.recovered_amount);
        if (remaining <= 0) {
          // Mark as completed
          await admin
            .from("debt_recovery_cases")
            .update({ status: "completed" })
            .eq("id", recoveryCase.id);
          results.push({ case_id: recoveryCase.id, action: "completed", deducted: 0 });
          continue;
        }

        // Get user's current wallet balance
        const { data: wallet } = await admin
          .from("wallets")
          .select("balance")
          .eq("user_id", recoveryCase.user_id)
          .single();

        const balance = Number(wallet?.balance || 0);
        if (balance <= 0) {
          results.push({ case_id: recoveryCase.id, action: "skipped_no_balance", balance: 0 });
          continue;
        }

        // Calculate deduction: percentage of remaining, capped by available balance
        const targetDeduction = Math.ceil(remaining * recoveryCase.recovery_percentage / 100);
        const deduction = Math.min(targetDeduction, balance, remaining);

        if (deduction <= 0) {
          results.push({ case_id: recoveryCase.id, action: "skipped_zero_deduction" });
          continue;
        }

        const newRemaining = remaining - deduction;

        // Create ledger entries
        const { data: txnGroupId, error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
          entries: [
            {
              user_id: recoveryCase.user_id,
              amount: deduction,
              direction: "cash_out",
              category: "debt_recovery",
              ledger_scope: "wallet",
              description: `Debt Recovery – Unauthorized Withdrawal Adjustment (${formatUGX(deduction)} of ${formatUGX(Number(recoveryCase.original_amount))} total, ${formatUGX(newRemaining)} remaining)`,
              currency: "UGX",
              source_table: "debt_recovery_cases",
              source_id: recoveryCase.id,
              transaction_date: new Date().toISOString(),
            },
            {
              direction: "cash_in",
              amount: deduction,
              category: "debt_recovery",
              ledger_scope: "platform",
              description: `Debt recovery collected – Case ${recoveryCase.id.slice(0, 8)}`,
              currency: "UGX",
              source_table: "debt_recovery_cases",
              source_id: recoveryCase.id,
              transaction_date: new Date().toISOString(),
            },
          ],
        });

        if (ledgerErr) {
          console.error(`[process-debt-recovery] Ledger error for case ${recoveryCase.id}:`, ledgerErr);
          results.push({ case_id: recoveryCase.id, action: "ledger_error", error: ledgerErr.message });
          continue;
        }

        // Record deduction
        await admin.from("debt_recovery_deductions").insert({
          case_id: recoveryCase.id,
          user_id: recoveryCase.user_id,
          amount: deduction,
          ledger_txn_group_id: txnGroupId,
          remaining_after: newRemaining,
        });

        // Update recovered amount
        const newRecovered = Number(recoveryCase.recovered_amount) + deduction;
        const newStatus = newRemaining <= 0 ? "completed" : "active";

        await admin
          .from("debt_recovery_cases")
          .update({
            recovered_amount: newRecovered,
            status: newStatus,
          })
          .eq("id", recoveryCase.id);

        // Audit log
        await admin.from("audit_logs").insert({
          user_id: recoveryCase.user_id,
          action_type: "debt_recovery_deduction",
          record_id: recoveryCase.id,
          table_name: "debt_recovery_cases",
          metadata: {
            deduction,
            previous_balance: balance,
            new_balance: balance - deduction,
            remaining_debt: newRemaining,
            original_amount: recoveryCase.original_amount,
            recovery_percentage: recoveryCase.recovery_percentage,
            txn_group_id: txnGroupId,
            reason_text: "Debt Recovery – Unauthorized Withdrawal Adjustment",
          },
        });

        results.push({
          case_id: recoveryCase.id,
          action: newStatus === "completed" ? "completed" : "deducted",
          deducted: deduction,
          remaining: newRemaining,
        });
      } catch (caseErr) {
        console.error(`[process-debt-recovery] Error processing case ${recoveryCase.id}:`, caseErr);
        results.push({ case_id: recoveryCase.id, action: "error", error: String(caseErr) });
      }
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[process-debt-recovery] Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function formatUGX(amount: number): string {
  return `UGX ${amount.toLocaleString()}`;
}
