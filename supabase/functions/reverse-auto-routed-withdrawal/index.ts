import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Reverses an auto-routed partner withdrawal that was approved against a
 * proxy agent's wallet (via SKYBUBBLES bulk settle or the approve-withdrawal
 * auto-route fallback). Safely:
 *   1. Posts mirror ledger entries (refunds the proxy wallet)
 *   2. Marks bulk_bank_payout_allocations.status = 'reversed' (frees the slot)
 *   3. Restores remaining capacity on the bulk gmail email
 *   4. Sets withdrawal_requests.status = 'rejected' with reason
 *   5. Writes an audit_log entry + emits a system_event
 * Idempotent on withdrawal_id (uses idempotency_key `reverse-{withdrawal_id}`).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Auth: staff user OR service-role system call
    const authHeader = req.headers.get("Authorization") || "";
    const tokenOnly = authHeader.replace(/^Bearer\s+/i, "");
    let actorId: string | null = null;
    if (tokenOnly && tokenOnly === serviceKey) {
      const { data: sys } = await admin
        .from("user_roles").select("user_id").eq("role", "super_admin").limit(1).maybeSingle();
      actorId = sys?.user_id || null;
    } else {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: roles } = await admin
        .from("user_roles").select("role").eq("user_id", user.id);
      const allowed = ["super_admin", "manager", "cfo", "coo", "operations"];
      if (!(roles || []).some((r: any) => allowed.includes(r.role))) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      actorId = user.id;
    }

    const body = await req.json().catch(() => ({}));
    const withdrawal_id: string | undefined = body?.withdrawal_id;
    const reason: string = (body?.reason || "").toString().trim();
    if (!withdrawal_id) {
      return new Response(JSON.stringify({ error: "withdrawal_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (reason.length < 10) {
      return new Response(JSON.stringify({ error: "reason must be at least 10 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch withdrawal + allocation
    const { data: wr } = await admin
      .from("withdrawal_requests")
      .select("id, user_id, amount, status, agent_id, proxy_partner_id")
      .eq("id", withdrawal_id)
      .maybeSingle();
    if (!wr) {
      return new Response(JSON.stringify({ error: "withdrawal not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotency: if already reversed, short-circuit
    const reverseKey = `reverse-${withdrawal_id}`;
    const { data: existingReverse } = await admin
      .from("general_ledger")
      .select("id")
      .eq("idempotency_key", reverseKey)
      .limit(1)
      .maybeSingle();
    if (existingReverse) {
      return new Response(JSON.stringify({ ok: true, already_reversed: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pull original ledger legs for this withdrawal (posted by approve-withdrawal)
    const { data: originalLegs } = await admin
      .from("general_ledger")
      .select("*")
      .or(`source_id.eq.${withdrawal_id},reference_id.eq.${withdrawal_id}`)
      .eq("source_table", "withdrawal_requests");

    if (!originalLegs || originalLegs.length === 0) {
      return new Response(JSON.stringify({ error: "no original ledger entries to reverse" }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build mirror entries: flip direction, preserve amount/account/wallet/recipient
    const reverseEntries = originalLegs.map((leg: any) => ({
      amount: Number(leg.amount),
      direction: leg.direction === "cash_in" ? "cash_out" : "cash_in",
      category: "system_balance_correction",
      description: `Reversal of withdrawal ${withdrawal_id.slice(0, 8)} — ${reason.slice(0, 100)}`,
      reference_id: withdrawal_id,
      user_id: leg.user_id,
      linked_party: leg.linked_party,
      source_table: "withdrawal_requests",
      source_id: withdrawal_id,
      account: leg.account,
      wallet_id: leg.wallet_id,
      recipient_type: leg.recipient_type,
      wallet_bucket: leg.wallet_bucket,
      ledger_scope: leg.ledger_scope,
      classification: "admin_correction",
      // Required by enforce_no_negative_wallet_ledger for any admin_correction
      // cash_out wallet leg. A withdrawal reversal is a duplicate/undo of the
      // original disbursement.
      solvency_bypass_reason: "duplicate_reversal",
      currency: leg.currency || "UGX",
      transaction_date: new Date().toISOString(),
    }));

    // Post the reversal transaction
    const { data: txId, error: txErr } = await admin.rpc("create_ledger_transaction", {
      entries: reverseEntries,
      idempotency_key: reverseKey,
      skip_balance_check: true,
    });
    if (txErr) {
      return new Response(JSON.stringify({ error: `ledger reversal failed: ${txErr.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Flag bulk allocation as reversed + restore email remaining capacity
    const { data: alloc } = await admin
      .from("bulk_bank_payout_allocations")
      .select("id, gmail_transaction_id, allocated_amount, status")
      .eq("withdrawal_request_id", withdrawal_id)
      .maybeSingle();

    if (alloc && alloc.status !== "reversed") {
      await admin
        .from("bulk_bank_payout_allocations")
        .update({
          status: "reversed",
          error_message: reason.slice(0, 500),
          metadata: { reversed_at: new Date().toISOString(), reversed_by: actorId },
        })
        .eq("id", alloc.id);

      const { data: tx } = await admin
        .from("gmail_transactions")
        .select("bulk_payout_allocated_total")
        .eq("id", alloc.gmail_transaction_id)
        .maybeSingle();
      if (tx) {
        const restored = Math.max(0, Number(tx.bulk_payout_allocated_total || 0) - Number(alloc.allocated_amount));
        await admin
          .from("gmail_transactions")
          .update({ bulk_payout_allocated_total: restored, bulk_payout_settled_at: null })
          .eq("id", alloc.gmail_transaction_id);
      }
    }

    // Mark withdrawal rejected
    await admin
      .from("withdrawal_requests")
      .update({
        status: "rejected",
        rejection_reason: reason,
        processed_by: actorId,
        processed_at: new Date().toISOString(),
      })
      .eq("id", withdrawal_id);

    // Audit log
    try {
      await admin.from("audit_logs").insert({
        action_type: "withdrawal_auto_route_reversed",
        table_name: "withdrawal_requests",
        record_id: withdrawal_id,
        user_id: actorId,
        reason,
        metadata: {
          reverse_ledger_tx: txId,
          bulk_allocation_id: alloc?.id || null,
          partner_id: wr.user_id,
          proxy_agent_id: wr.agent_id || wr.proxy_partner_id,
          amount: wr.amount,
        },
      });
    } catch (_) { /* non-fatal */ }

    try {
      await admin.from("system_events").insert({
        event_type: "withdrawal.auto_route.reversed",
        payload: {
          withdrawal_id,
          actor_id: actorId,
          reason,
          bulk_allocation_id: alloc?.id || null,
          amount: wr.amount,
        },
      });
    } catch (_) { /* non-fatal */ }

    return new Response(
      JSON.stringify({ ok: true, withdrawal_id, reverse_ledger_tx: txId, bulk_reverted: !!alloc }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});