// Cash-with-agent deposit — Step 2.
// The depositor enters the 4-digit PIN that the agent read back to them after
// handing over the cash. On a match we atomically claim the session, re-check
// the agent's float, and post a single balanced ledger transaction that:
//   • debits the agent's OPERATIONAL FLOAT (wallet, recipient_type=operational_wallet)
//   • credits the depositor's WITHDRAWABLE wallet (wallet, recipient_type=user)
// Wallet bucket caches are updated by the ledger triggers (sole-writer rule).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) return json(401, { error: "Unauthorized" });
    const depositor = authData.user;

    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
    const enteredPin = String(body?.pin ?? "").replace(/\D/g, "");
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(sessionId)) {
      return json(400, { error: "invalid_request", message: "Missing deposit reference" });
    }
    if (enteredPin.length !== 4) {
      return json(400, { error: "invalid_pin", message: "Enter the 4-digit code" });
    }

    // ── Load the session (scoped to this depositor) ──
    const { data: session, error: sErr } = await admin
      .from("agent_cash_deposit_sessions")
      .select("id, depositor_id, depositor_name, agent_id, amount, pin, status, attempts, max_attempts, expires_at")
      .eq("id", sessionId)
      .eq("depositor_id", depositor.id)
      .maybeSingle();

    if (sErr || !session) {
      return json(404, { error: "not_found", message: "No pending cash deposit found." });
    }
    const s = session as any;

    if (s.status === "completed") {
      return json(200, { ok: true, already_verified: true, message: "This deposit was already completed." });
    }
    if (s.status !== "pending") {
      return json(410, { error: "not_active", message: "This deposit is no longer active. Please start a new one." });
    }
    if (new Date(s.expires_at).getTime() < Date.now()) {
      await admin.from("agent_cash_deposit_sessions").update({ status: "expired" }).eq("id", s.id);
      return json(410, { error: "expired", message: "This code has expired. Please start a new cash deposit." });
    }
    if (Number(s.attempts) >= Number(s.max_attempts)) {
      await admin.from("agent_cash_deposit_sessions").update({ status: "expired" }).eq("id", s.id);
      return json(429, { error: "too_many_attempts", message: "Too many incorrect attempts. Please start a new cash deposit." });
    }

    // ── PIN check ──
    if (enteredPin !== String(s.pin)) {
      const newAttempts = Number(s.attempts) + 1;
      const lock = newAttempts >= Number(s.max_attempts);
      await admin
        .from("agent_cash_deposit_sessions")
        .update({ attempts: newAttempts, ...(lock ? { status: "expired" } : {}) })
        .eq("id", s.id);
      const remaining = Math.max(0, Number(s.max_attempts) - newAttempts);
      return json(400, {
        error: "pin_mismatch",
        message: lock
          ? "Incorrect code. Too many attempts — please start a new cash deposit."
          : `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
        attempts_remaining: remaining,
      });
    }

    // ── Atomically claim the session BEFORE crediting (idempotency guard) ──
    const { data: claimed, error: claimErr } = await admin
      .from("agent_cash_deposit_sessions")
      .update({ status: "completed", attempts: Number(s.attempts) + 1, completed_at: new Date().toISOString() })
      .eq("id", s.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr || !claimed) {
      return json(200, { ok: true, already_verified: true, message: "This deposit was already completed." });
    }

    const amount = Number(s.amount);

    // ── Re-check the agent's float at claim time (fresh) ──
    const { data: floatData, error: floatErr } = await admin.rpc("get_agent_float_balance", {
      p_agent_id: s.agent_id,
    });
    const agentFloat = Number(floatData ?? 0);
    if (floatErr || agentFloat < amount) {
      // Roll the session back so it isn't stuck "completed" without money moving.
      await admin.from("agent_cash_deposit_sessions")
        .update({ status: "pending", completed_at: null }).eq("id", s.id);
      return json(400, {
        error: "insufficient_agent_float",
        message: "The agent no longer has enough float to complete this deposit.",
      });
    }

    const nowIso = new Date().toISOString();
    // Balanced double-entry: cash_in total == cash_out total.
    //  1) agent float DOWN  (wallet, operational_wallet bucket)
    //  2) platform counter for (1)
    //  3) depositor withdrawable UP (wallet, user bucket)
    //  4) platform counter for (3)
    const { data: txnGroup, error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: s.agent_id,
          amount,
          direction: "cash_out",
          category: "agent_float_settlement",
          ledger_scope: "wallet",
          classification: "production",
          description: `Cash deposit to ${s.depositor_name ?? "user"} — float converted to user wallet`,
          currency: "UGX",
          recipient_type: "operational_wallet",
          linked_party: s.depositor_id,
          source_table: "agent_cash_deposit_sessions",
          source_id: s.id,
          transaction_date: nowIso,
        },
        {
          user_id: s.agent_id,
          amount,
          direction: "cash_in",
          category: "agent_float_settlement",
          ledger_scope: "platform",
          classification: "production",
          description: "Agent float settled against user cash deposit",
          currency: "UGX",
          source_table: "agent_cash_deposit_sessions",
          source_id: s.id,
          transaction_date: nowIso,
        },
        {
          user_id: s.depositor_id,
          amount,
          direction: "cash_in",
          category: "wallet_deposit",
          ledger_scope: "wallet",
          classification: "production",
          description: "Cash deposit received via Welile agent",
          currency: "UGX",
          recipient_type: "user",
          linked_party: s.agent_id,
          source_table: "agent_cash_deposit_sessions",
          source_id: s.id,
          transaction_date: nowIso,
        },
        {
          user_id: s.depositor_id,
          amount,
          direction: "cash_out",
          category: "wallet_deposit",
          ledger_scope: "platform",
          classification: "production",
          description: "Platform counter-entry for agent cash deposit",
          currency: "UGX",
          source_table: "agent_cash_deposit_sessions",
          source_id: s.id,
          transaction_date: nowIso,
        },
      ],
    });

    if (ledgerErr) {
      console.error("[agent-cash-confirm] ledger failed", ledgerErr);
      // Roll back the claim so the depositor can retry.
      await admin.from("agent_cash_deposit_sessions")
        .update({ status: "pending", completed_at: null }).eq("id", s.id);
      return json(500, {
        error: "ledger_failed",
        message: "Could not credit your wallet. Please try again.",
        details: ledgerErr.message,
      });
    }

    await admin.from("agent_cash_deposit_sessions")
      .update({ ledger_txn_group: txnGroup as any }).eq("id", s.id);

    try {
      await admin.from("audit_logs").insert({
        user_id: s.depositor_id,
        action_type: "agent_cash_deposit_completed",
        table_name: "agent_cash_deposit_sessions",
        record_id: s.id,
        metadata: {
          agent_id: s.agent_id,
          amount,
          txn_group_id: txnGroup,
          reason: "Agent cash deposit confirmed via 4-digit code",
        },
      } as any);
      await admin.from("system_events").insert({
        event_type: "funds_added",
        user_id: s.depositor_id,
        related_entity_type: "wallet",
        related_entity_id: s.id,
        metadata: { kind: "agent_cash_deposit", session_id: s.id, agent_id: s.agent_id, amount, txn_group_id: txnGroup },
      } as any);
    } catch (_e) { /* non-fatal */ }

    return json(200, { ok: true, amount, txn_group_id: txnGroup });
  } catch (e) {
    console.error("[agent-cash-confirm] error", e);
    return json(500, { error: "server_error", message: String((e as Error)?.message ?? e) });
  }
});