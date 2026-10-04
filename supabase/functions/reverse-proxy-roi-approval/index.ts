import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Reverses one or more CFO-approved proxy-partner ROI payouts (pending_wallet_operations
 * with category roi_payout / supporter_platform_rewards, status 'approved').
 *
 * For each approval it:
 *   1. Blocks if the approval was already (partly) settled by a delivered withdrawal.
 *   2. Blocks if the recipient wallet no longer holds the credited withdrawable funds.
 *   3. Posts a balanced ledger reversal (mirror of the original credit legs) so the
 *      money leaves the wallet it was credited to. Uses system_balance_correction /
 *      admin_correction, mirroring reverse-auto-routed-withdrawal.
 *   4. Rolls the portfolio's next_roi_date back one month so it re-enters the COO
 *      "Nearing Payout" list.
 *   5. Marks the operation status = 'cancelled' so it drops from the agent queue.
 *   6. Writes an audit_log entry + emits a system_event.
 *
 * Idempotent per approval via idempotency_key `reverse-roi-approval-{id}`.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claims, error: claimsErr } = await userClient.auth.getUser();
    if (claimsErr || !claims?.user) return json({ error: "Unauthorized" }, 401);
    const actorId = claims.user.id as string;

    const body = await req.json().catch(() => ({}));
    const approvalIds: string[] = Array.isArray(body?.approval_ids)
      ? body.approval_ids.filter((x: unknown) => typeof x === "string")
      : [];
    const reason: string = (body?.reason || "").toString().trim();

    if (approvalIds.length === 0) return json({ error: "approval_ids required" }, 400);
    if (approvalIds.length > 50) return json({ error: "Too many approvals (max 50)" }, 400);
    if (reason.length < 10) return json({ error: "reason must be at least 10 characters" }, 400);

    // The acting agent must own the proxy relationship (or be staff).
    const { data: roles } = await admin
      .from("user_roles").select("role").eq("user_id", actorId);
    const isStaff = (roles || []).some((r: any) =>
      ["super_admin", "manager", "cfo", "coo", "operations"].includes(r.role));

    const reversed: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    let portfolioRolledBack: string | null = null;

    for (const opId of approvalIds) {
      // 1. Fetch fresh operation
      const { data: op } = await admin
        .from("pending_wallet_operations")
        .select("*")
        .eq("id", opId)
        .maybeSingle();

      if (!op) { skipped.push({ id: opId, reason: "not found" }); continue; }
      if (!["roi_payout", "supporter_platform_rewards"].includes(op.category)) {
        skipped.push({ id: opId, reason: "not an ROI payout" }); continue;
      }
      if (op.status !== "approved") {
        skipped.push({ id: opId, reason: `status is ${op.status}, not approved` }); continue;
      }

      // Ownership: agent must be the target wallet holder (custody) unless staff.
      if (!isStaff && op.target_wallet_user_id && op.target_wallet_user_id !== actorId) {
        skipped.push({ id: opId, reason: "not your proxy approval" }); continue;
      }

      // 2. Idempotency
      const idemKey = `reverse-roi-approval-${opId}`;
      const { data: already } = await admin
        .from("general_ledger").select("id").eq("idempotency_key", idemKey).limit(1).maybeSingle();
      if (already) { reversed.push(opId); continue; }

      // 3. Settlement guard — never reverse money already delivered
      const { data: settlements } = await admin
        .from("proxy_payout_settlements")
        .select("amount_settled").eq("approval_id", opId);
      const settledTotal = (settlements || []).reduce(
        (s: number, r: any) => s + (Number(r.amount_settled) || 0), 0);
      if (settledTotal > 0) {
        skipped.push({ id: opId, reason: "already settled by a delivered withdrawal" }); continue;
      }

      // 4. Find the original balanced ledger group by the operation's unique reference.
      let originalLegs: any[] | null = null;
      if (op.reference_id) {
        const { data: walletLeg } = await admin
          .from("general_ledger")
          .select("transaction_group_id")
          .eq("reference_id", op.reference_id)
          .eq("category", "roi_wallet_credit")
          .eq("direction", "cash_in")
          .eq("amount", op.amount)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (walletLeg?.transaction_group_id) {
          const { data: legs } = await admin
            .from("general_ledger")
            .select("*")
            .eq("transaction_group_id", walletLeg.transaction_group_id);
          originalLegs = legs || null;
        }
      }
      if (!originalLegs || originalLegs.length === 0) {
        skipped.push({ id: opId, reason: "original ledger entries not found" }); continue;
      }

      // 5. Verify the credited wallet still holds the funds in withdrawable
      const creditLeg = originalLegs.find(
        (l: any) => l.ledger_scope === "wallet" && l.direction === "cash_in");
      if (creditLeg?.user_id) {
        const { data: w } = await admin
          .from("wallets")
          .select("withdrawable_balance")
          .eq("user_id", creditLeg.user_id)
          .maybeSingle();
        const withdrawable = Number(w?.withdrawable_balance || 0);
        if (withdrawable + 1 < Number(op.amount)) {
          skipped.push({
            id: opId,
            reason: `funds no longer available in wallet (has ${Math.round(withdrawable)}, needs ${op.amount})`,
          });
          continue;
        }
      }

      // 6. Post the balanced reversal (mirror legs)
      const reverseEntries = originalLegs.map((leg: any) => ({
        amount: Number(leg.amount),
        direction: leg.direction === "cash_in" ? "cash_out" : "cash_in",
        category: "system_balance_correction",
        description: `Reversal of ROI approval ${opId.slice(0, 8)} — ${reason.slice(0, 100)}`,
        reference_id: opId,
        user_id: leg.user_id,
        linked_party: leg.linked_party,
        source_table: "pending_wallet_operations",
        source_id: opId,
        account: leg.account,
        wallet_bucket: leg.wallet_bucket || (leg.ledger_scope === "wallet" ? leg.account : null),
        recipient_type: leg.recipient_type,
        ledger_scope: leg.ledger_scope,
        classification: "admin_correction",
        solvency_bypass_reason: "duplicate_reversal",
        currency: leg.currency || "UGX",
        transaction_date: new Date().toISOString(),
      }));

      const { data: txId, error: txErr } = await admin.rpc("create_ledger_transaction", {
        entries: reverseEntries,
        idempotency_key: idemKey,
        skip_balance_check: true,
      });
      if (txErr) {
        skipped.push({ id: opId, reason: `ledger reversal failed: ${txErr.message}` });
        continue;
      }

      // 7. Roll back next_roi_date one month so it re-enters Nearing Payout
      if (op.source_table === "investor_portfolios" && op.source_id) {
        try {
          const { data: portfolio } = await admin
            .from("investor_portfolios")
            .select("next_roi_date, created_at, payout_day")
            .eq("id", op.source_id)
            .maybeSingle();
          if (portfolio?.next_roi_date) {
            const cur = new Date(portfolio.next_roi_date + "T00:00:00");
            const prev = new Date(cur.getFullYear(), cur.getMonth() - 1, cur.getDate());
            const prevStr = prev.toISOString().split("T")[0];
            await admin
              .from("investor_portfolios")
              .update({ next_roi_date: prevStr })
              .eq("id", op.source_id);
            portfolioRolledBack = op.source_id;
          }
        } catch (dateErr) {
          console.error(`[reverse-roi] next_roi_date rollback failed for ${op.source_id}:`, dateErr);
        }
      }

      // 8. Mark the operation cancelled so it drops from the agent queue
      await admin
        .from("pending_wallet_operations")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
          metadata: {
            ...(op.metadata || {}),
            reversed_to_nearing_payout: true,
            reversed_by: actorId,
            reversed_at: new Date().toISOString(),
            reversal_reason: reason,
            reversal_ledger_tx: txId,
          },
        })
        .eq("id", opId);

      // 9. Audit + system event (non-fatal)
      try {
        await admin.from("audit_logs").insert({
          user_id: actorId,
          action_type: "proxy_roi_approval_reversed",
          table_name: "pending_wallet_operations",
          record_id: opId,
          reason,
          metadata: {
            partner_id: op.user_id,
            portfolio_id: op.source_id,
            amount: op.amount,
            reverse_ledger_tx: txId,
          },
        });
      } catch (_) { /* non-fatal */ }
      try {
        await admin.from("system_events").insert({
          event_type: "proxy.roi_approval.reversed",
          payload: {
            approval_id: opId,
            actor_id: actorId,
            partner_id: op.user_id,
            portfolio_id: op.source_id,
            amount: op.amount,
            reason,
          },
        });
      } catch (_) { /* non-fatal */ }

      reversed.push(opId);
    }

    return json({
      ok: reversed.length > 0,
      reversed_count: reversed.length,
      reversed,
      skipped,
      portfolio_rolled_back: portfolioRolledBack,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
