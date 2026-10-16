import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { topupHoldEntries, topupHoldKey } from "../_shared/topupFloatHold.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Treasury guard: portfolio top-ups move money — block when paused
    const guardBlock = await checkTreasuryGuard(supabase, "any", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    // Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { portfolio_id, amount } = body;

    // Validate inputs
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!portfolio_id || !UUID_RE.test(portfolio_id)) {
      return new Response(JSON.stringify({ error: "Invalid portfolio_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const topupAmount = Number(amount);
    if (!topupAmount || topupAmount < 1000) {
      return new Response(JSON.stringify({ error: "Minimum top-up is UGX 1,000" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (topupAmount > 200_000_000_000) {
      return new Response(JSON.stringify({ error: "Amount exceeds maximum" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify portfolio belongs to the user (investor_id or agent_id)
    const { data: portfolio, error: pErr } = await supabase
      .from("investor_portfolios")
      .select("id, investor_id, agent_id, investment_amount, status, portfolio_code, account_name")
      .eq("id", portfolio_id)
      .single();

    if (pErr || !portfolio) {
      return new Response(JSON.stringify({ error: "Portfolio not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (portfolio.investor_id !== user.id && portfolio.agent_id !== user.id) {
      return new Response(JSON.stringify({ error: "You do not own this portfolio" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (portfolio.status === "cancelled") {
      return new Response(JSON.stringify({ error: "Cannot top up a cancelled portfolio" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Funding source = OPERATIONAL FLOAT (never withdrawable), same as new
    // portfolios in create-portfolio-invite. funder_float_available already
    // nets out float earmarked for pending new portfolios.
    const { data: floatAvailRaw, error: availErr } = await supabase.rpc("funder_float_available", {
      p_user_id: user.id,
    });
    if (availErr) {
      console.error("[portfolio-topup] float balance lookup failed:", availErr);
      return new Response(JSON.stringify({ error: "Could not verify your operational float. Please retry." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const floatAvail = Number(floatAvailRaw ?? 0);
    if (floatAvail < topupAmount) {
      return new Response(JSON.stringify({
        error: `Insufficient operational float. Need UGX ${topupAmount.toLocaleString()}, but only UGX ${floatAvail.toLocaleString()} is available.`,
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const opId = crypto.randomUUID();
    const txGroupId = crypto.randomUUID();
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;
    const partnerId = portfolio.investor_id || portfolio.agent_id || user.id;
    const now = new Date().toISOString();
    const holdKey = topupHoldKey(opId);

    // ── HOLD-AT-REQUEST FLOW ──
    // The top-up amount leaves the partner's operational float NOW and is
    // parked as pending capital, so it cannot be spent while it waits.
    // Partner Ops still approves; the 7pm engine applies it after the next
    // Returns payout. Reject/cancel return it to float.
    // 1. Record the request first (float_hold: pending) so a held amount
    //    always has an op pointing at it.
    const baseMeta = {
      fund_source: "float",
      source_wallet_user_id: user.id,
      source_wallet_owner: "Operational Float",
      requested_at: now,
      requested_float_available: floatAvail,
      hold_idempotency_key: holdKey,
    };
    const { error: pendingErr } = await supabase.from("pending_wallet_operations").insert({
      id: opId,
      user_id: user.id,
      amount: topupAmount,
      direction: "cash_in",
      category: "pending_portfolio_topup",
      source_table: "investor_portfolios",
      source_id: portfolio_id,
      transaction_group_id: txGroupId,
      description: `Wallet-to-portfolio top-up for ${accountLabel} — held from operational float, awaiting Partner Ops approval`,
      linked_party: "platform",
      status: "awaiting_verification",
      operation_type: "portfolio_topup",
      metadata: { ...baseMeta, float_hold: "pending" },
    });

    if (pendingErr) {
      console.error("[portfolio-topup] Failed to record request:", pendingErr);
      return new Response(JSON.stringify({ error: "Failed to submit transfer request." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Take the hold. Float debits get no balance check inside
    //    create_ledger_transaction (it only checks withdrawable), so the
    //    funder_float_available check above is the gate.
    const { data: holdGroupId, error: holdErr } = await supabase.rpc("create_ledger_transaction", {
      idempotency_key: holdKey,
      entries: topupHoldEntries({
        walletUserId: user.id,
        partnerId,
        amount: topupAmount,
        portfolioId: portfolio_id,
        portfolioCode: portfolio.portfolio_code,
        label: accountLabel,
      }),
    });

    if (holdErr) {
      console.error("[portfolio-topup] float hold failed:", holdErr);
      await supabase
        .from("pending_wallet_operations")
        .update({
          status: "cancelled",
          rejection_reason: "Operational float hold failed — no funds moved",
          metadata: { ...baseMeta, float_hold: "failed", hold_error: holdErr.message },
        })
        .eq("id", opId);
      return new Response(JSON.stringify({ error: "Could not hold the top-up from your operational float. No funds moved." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase
      .from("pending_wallet_operations")
      .update({ metadata: { ...baseMeta, float_hold: "held", hold_group_id: holdGroupId, held_at: now } })
      .eq("id", opId);

    await supabase.rpc("repair_wallet_cache_for_user", { p_user_id: user.id }).then(
      ({ error }: any) => { if (error) console.warn("[portfolio-topup] wallet cache repair failed (cron will reconcile):", error); },
    );

    console.log(`[portfolio-topup] User ${user.id} top-up of ${topupAmount} for ${portfolio_id} — held from operational float (op ${opId}), awaiting Partner Ops approval`);

    // Log system event
    logSystemEvent(supabase, 'portfolio_topup', user.id, 'investor_portfolios', portfolio_id, { amount: topupAmount, portfolio_code: portfolio.portfolio_code });


    // Notify Partner Ops / managers that a transfer request needs approval (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "📥 Portfolio Transfer Request", body: `A wallet→portfolio transfer of UGX ${topupAmount.toLocaleString()} needs Partner Ops approval`, url: "/dashboard/manager" }),
    }).catch(() => {});

    // Push notification to partner (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [user.id],
        payload: { title: "📤 Transfer Request Submitted", body: `UGX ${topupAmount.toLocaleString()} has been set aside from your operational float for your portfolio top-up. It is awaiting Partner Ops approval and returns to your float if declined.`, url: "/dashboard/funder", type: "info" },
      }),
    }).catch(() => {});


    // NOTE: The partnership top-up CONFIRMATION email is intentionally NOT sent
    // here — it is dispatched by `approve-portfolio-topup` once Partner Ops
    // approves the transfer.

    return new Response(JSON.stringify({
      success: true,
      amount: topupAmount,
      status: "awaiting_approval",
      requested: true,
      held: true,
      current_capital: Number(portfolio.investment_amount),
      portfolio_code: portfolio.portfolio_code,
      message: "Top-up submitted. The amount is held from your operational float until Partner Ops approves it, and returns to your float if declined.",
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[portfolio-topup] Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
