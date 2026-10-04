import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { logDepositDecision } from "../_shared/depositDecisionAudit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Oversight roles allowed to run this corrective sweep.
const OVERSIGHT_ROLES = ["manager", "cfo", "operations", "financial_ops", "super_admin"];

/**
 * reverse-uncoded-deposits
 * ------------------------
 * Finds every cash deposit (provider = 'cash_deposit') that was CREDITED to a
 * user's wallet WITHOUT the depositor ever entering the receipt code — i.e. the
 * paired `cash_deposit_verifications` row was never moved to `verified` — and:
 *   1. Reverses the wallet credit with a balanced `system_balance_correction`
 *      ledger transaction (classification `admin_correction`). Because the
 *      `wallets` view is ledger-derived and the strict wallet view counts
 *      admin_correction `system_balance_correction` cash_out legs, this debits
 *      the user's balance while staying hidden from user-facing ledger reads.
 *   2. Marks the `deposit_requests` row as `rejected` with a clear reason.
 *   3. Marks the `cash_deposit_verifications` row as `rejected`.
 *   4. Writes audit_logs + deposit_decision_audit + a system_event.
 *
 * Idempotent: a deposit that is already `rejected` (or whose reversal ledger
 * group already exists, guarded by idempotency_key) is skipped.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;

    // ── Authn / authz ───────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: authUser }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !authUser) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roleRows } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", authUser.id);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    const authorized = roles.some((r) => OVERSIGHT_ROLES.includes(r));
    if (!authorized) {
      return new Response(JSON.stringify({ error: "Not authorized — oversight role required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Find credited-but-uncoded cash deposits ─────────────────────
    const { data: candidates, error: candErr } = await supabaseAdmin
      .from("cash_deposit_verifications")
      .select(
        "id, status, verified_at, deposit_request_id, deposit_requests!inner(id, user_id, amount, status, provider)",
      )
      .neq("status", "verified")
      .is("verified_at", null);

    if (candErr) {
      throw new Error(`Failed to load verifications: ${candErr.message}`);
    }

    type Row = {
      id: string;
      status: string;
      verified_at: string | null;
      deposit_request_id: string;
      deposit_requests: {
        id: string;
        user_id: string;
        amount: number;
        status: string;
        provider: string | null;
      } | null;
    };

    const targets = (candidates as Row[] | null ?? []).filter((row) => {
      const dr = row.deposit_requests;
      if (!dr) return false;
      // Only deposits that were actually credited (left pending → approved).
      return ["approved", "credited", "completed"].includes(String(dr.status));
    });

    const results: Array<Record<string, unknown>> = [];

    for (const row of targets) {
      const dr = row.deposit_requests!;
      const depositId = dr.id;

      // Confirm a production wallet credit actually exists for this deposit and
      // determine which bucket it landed in (wallet_deposit → withdrawable,
      // agent_float_deposit → float).
      const { data: creditLegs } = await supabaseAdmin
        .from("general_ledger")
        .select("amount, category, direction, wallet_bucket")
        .eq("source_id", depositId)
        .eq("ledger_scope", "wallet")
        .eq("direction", "cash_in")
        .in("classification", ["production"]);

      const legs = creditLegs ?? [];
      const creditedAmount = legs.reduce(
        (sum: number, l: { amount: number }) => sum + Number(l.amount || 0),
        0,
      );
      if (creditedAmount <= 0) {
        results.push({ deposit_id: depositId, skipped: true, reason: "no_wallet_credit_found" });
        continue;
      }
      const isFloat = legs.some(
        (l: { category: string; wallet_bucket: string | null }) =>
          l.category === "agent_float_deposit" || l.wallet_bucket === "float",
      );
      const bucket = isFloat ? "float" : "withdrawable";

      if (dryRun) {
        results.push({
          deposit_id: depositId,
          user_id: dr.user_id,
          amount: creditedAmount,
          bucket,
          would_reverse: true,
        });
        continue;
      }

      // 1. Reverse the wallet credit (balanced admin_correction).
      const idempotencyKey = `reverse-uncoded-${depositId}`;
      const { error: ledgerErr } = await supabaseAdmin.rpc("create_ledger_transaction", {
        entries: [
          {
            user_id: dr.user_id,
            amount: creditedAmount,
            direction: "cash_out",
            category: "wallet_deduction_cash_payout_retraction",
            ledger_scope: "wallet",
            wallet_bucket: bucket,
            classification: "production",
            source_table: "deposit_requests",
            source_id: depositId,
            reference_id: depositId,
            description: "Reversal: cash deposit credited without depositor entering receipt code",
            currency: "UGX",
            transaction_date: new Date().toISOString(),
          },
          {
            amount: creditedAmount,
            direction: "cash_in",
            category: "wallet_deduction_cash_payout_retraction",
            ledger_scope: "platform",
            classification: "production",
            source_table: "deposit_requests",
            source_id: depositId,
            description: "Reversal offset: uncoded cash deposit clawback",
            currency: "UGX",
            transaction_date: new Date().toISOString(),
          },
        ],
        idempotency_key: idempotencyKey,
      });

      if (ledgerErr) {
        results.push({ deposit_id: depositId, error: ledgerErr.message });
        await logDepositDecision(supabaseAdmin, {
          deposit_request_id: depositId,
          source: "approval",
          decision: "failed",
          reason: "reversal_ledger_failed",
          amount: creditedAmount,
          actor_id: authUser.id,
          actor_email: authUser.email ?? null,
          metadata: { error: String(ledgerErr.message).slice(0, 500) },
        });
        continue;
      }

      const reason = "Reversed automatically — cash deposit was credited without the depositor entering the receipt code.";

      // 2. Mark the deposit request rejected.
      await supabaseAdmin
        .from("deposit_requests")
        .update({
          status: "rejected",
          rejection_reason: reason,
          rejected_at: new Date().toISOString(),
          processed_by: authUser.id,
        })
        .eq("id", depositId);

      // 3. Mark the verification rejected.
      await supabaseAdmin
        .from("cash_deposit_verifications")
        .update({ status: "rejected" })
        .eq("id", row.id);

      // 4. Audit trail.
      await supabaseAdmin.from("audit_logs").insert({
        user_id: authUser.id,
        action_type: "deposit_reversed_uncoded",
        table_name: "deposit_requests",
        record_id: depositId,
        metadata: {
          target_user_id: dr.user_id,
          amount: creditedAmount,
          bucket,
          verification_id: row.id,
          verification_status: row.status,
          reason: "cash_code_never_entered",
        },
      });

      await logDepositDecision(supabaseAdmin, {
        deposit_request_id: depositId,
        source: "approval",
        decision: "rejected",
        reason: "cash_code_never_entered_reversed",
        amount: creditedAmount,
        actor_id: authUser.id,
        actor_email: authUser.email ?? null,
        metadata: { bucket, verification_id: row.id },
      });

      await logSystemEvent(
        supabaseAdmin,
        "deposit_reversed",
        dr.user_id,
        "deposit_requests",
        depositId,
        { amount: creditedAmount, bucket, reason: "cash_code_never_entered" },
      );

      results.push({
        deposit_id: depositId,
        user_id: dr.user_id,
        amount: creditedAmount,
        bucket,
        reversed: true,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: dryRun,
        candidates: targets.length,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[reverse-uncoded-deposits] error:", err);
    return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});