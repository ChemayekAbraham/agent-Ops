import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Bulk reverse agent advances.
 *
 * Runs the SAME two-step reversal the single-advance CFO dialog does, per advance:
 *   1. CFO Direct Debit clawback (`cfo-direct-credit`, operation: debit) for the
 *      amount the agent actually still holds — the only permitted wallet ->
 *      platform debit path. Skipped when nothing is recoverable.
 *   2. `reverse_agent_advance` RPC, which stops deductions, clears the advance,
 *      sends the request back to Waiting for Approval and writes the audit +
 *      system event. Never drives a wallet negative; the un-recovered part is
 *      recorded as a shortfall.
 *
 * All advances processed in one call share a single `clawback_group_id` so the
 * batch is traceable as one event. Amounts are always taken from the
 * authoritative approval / disbursement / ledger records via
 * `advance_reversal_plan_batch` — never from client input.
 *
 * Chunked on purpose: the client sends at most CHUNK_LIMIT ids per call and
 * loops, so a large batch cannot hit the function timeout.
 */
const CHUNK_LIMIT = 25;

interface PlanRow {
  advance_id: string;
  agent_id: string;
  agent_name: string | null;
  already_reversed: boolean;
  approved_today: boolean;
  has_request: boolean;
  disbursed_amount: number;
  clawback_posted_amount: number;
  amount_to_reverse: number;
  recoverable_now: number;
  shortfall: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["cfo", "manager", "super_admin"]);
    if (!roles?.length) return json({ error: "Only the CFO or Management can reverse advances" }, 403);

    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.advance_ids) ? body.advance_ids.filter(Boolean) : [];
    const reason: string = typeof body?.reason === "string" ? body.reason.trim() : "";
    const groupId: string | null = typeof body?.clawback_group_id === "string" ? body.clawback_group_id : null;

    if (ids.length === 0) return json({ error: "No advances selected" }, 400);
    if (ids.length > CHUNK_LIMIT) return json({ error: `Send at most ${CHUNK_LIMIT} advances per call` }, 400);
    if (reason.length < 10) return json({ error: "A reversal reason of at least 10 characters is required" }, 400);

    // Caller-scoped client: reverse_agent_advance authorises on auth.uid().
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // One round trip for every plan in this chunk.
    const { data: planData, error: planError } = await userClient.rpc("advance_reversal_plan_batch", {
      p_advance_ids: ids,
      p_today_only: false,
    });
    if (planError) return json({ error: planError.message }, 400);
    const plans = ((planData as any)?.rows ?? []) as PlanRow[];
    const planById = new Map(plans.map((p) => [p.advance_id, p]));

    const results: Array<Record<string, unknown>> = [];
    let recoveredTotal = 0;
    let shortfallTotal = 0;
    let reversedCount = 0;

    for (const id of ids) {
      const plan = planById.get(id);
      if (!plan) {
        results.push({ advance_id: id, outcome: "error", message: "Advance not found" });
        continue;
      }
      if (plan.already_reversed) {
        results.push({
          advance_id: id, agent_name: plan.agent_name,
          outcome: "skipped", message: "Already reversed",
        });
        continue;
      }
      if (!plan.approved_today) {
        results.push({
          advance_id: id, agent_name: plan.agent_name,
          outcome: "skipped", message: "Outside the same-day reversal window",
        });
        continue;
      }
      if (!plan.has_request) {
        results.push({
          advance_id: id, agent_name: plan.agent_name,
          outcome: "skipped", message: "No originating request — use Cancel instead",
        });
        continue;
      }

      const recoverable = Math.max(0, Number(plan.recoverable_now || 0));
      let debitGroupId: string | null = groupId;

      try {
        if (recoverable > 0) {
          const debitRes = await fetch(`${supabaseUrl}/functions/v1/cfo-direct-credit`, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              apikey: anonKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              target_user_id: plan.agent_id,
              amount: recoverable,
              reason: `Advance reversal — ${reason}`,
              operation: "debit",
              wallet_category: "wallet_transfer",
              platform_category: "wallet_transfer",
              financial_impact: "neutral",
              category_label: "Agent advance reversal (clawback)",
              recipient_type: "user",
              // Evidence tag the reversal RPC looks for in cfo_debit_obligations.
              sub_category: `advance_reversal:${id}`,
              manual_credit: true,
            }),
          });
          const debitBody = await debitRes.json().catch(() => ({}));
          if (!debitRes.ok || debitBody?.error) {
            throw new Error(debitBody?.error || `Wallet clawback failed (${debitRes.status})`);
          }
          debitGroupId = debitBody?.transaction_group_id ?? groupId;
        }

        const { data: rpcResult, error: rpcError } = await userClient.rpc("reverse_agent_advance", {
          p_advance_id: id,
          p_reason: reason,
          p_clawback_amount: recoverable,
          p_clawback_group_id: debitGroupId,
        });
        if (rpcError) throw rpcError;

        const recovered = Number((rpcResult as any)?.clawback_amount || 0);
        const unrecovered = Number((rpcResult as any)?.unrecovered_shortfall || 0);
        recoveredTotal += recovered;
        shortfallTotal += unrecovered;
        reversedCount += 1;
        results.push({
          advance_id: id,
          agent_id: plan.agent_id,
          agent_name: plan.agent_name,
          outcome: "reversed",
          disbursed: Number(plan.disbursed_amount || 0),
          recovered,
          shortfall: unrecovered,
        });
      } catch (e) {
        results.push({
          advance_id: id,
          agent_id: plan.agent_id,
          agent_name: plan.agent_name,
          outcome: "error",
          message: (e as Error).message,
        });
      }
    }

    return json({
      success: true,
      processed: ids.length,
      reversed: reversedCount,
      recovered_total: recoveredTotal,
      shortfall_total: shortfallTotal,
      results,
    });
  } catch (e) {
    console.error("[bulk-reverse-agent-advances]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
