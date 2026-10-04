import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";

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

    // Fetch user wallet with optimistic lock
    const { data: wallet, error: wErr } = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", user.id)
      .single();

    if (wErr || !wallet) {
      return new Response(JSON.stringify({ error: "Wallet not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currentBalance = Number(wallet.balance);
    if (currentBalance < topupAmount) {
      return new Response(JSON.stringify({ error: "Insufficient wallet balance" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const txGroupId = crypto.randomUUID();
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;
    const now = new Date().toISOString();

    // ── REQUEST-ONLY FLOW ──
    // Wallet → portfolio transfers no longer move real funds instantly.
    // We record a REQUEST for Partner Ops in `awaiting_verification` and
    // create NO ledger entry here, so the partner's wallet is NOT debited.
    // The funds only leave the wallet when Partner Ops approves via
    // `approve-portfolio-topup`, which performs the actual wallet debit
    // at approval time (re-validating the balance first).
    const { error: pendingErr } = await supabase.from("pending_wallet_operations").insert({
      user_id: user.id,
      amount: topupAmount,
      direction: "cash_in",
      category: "pending_portfolio_topup",
      source_table: "investor_portfolios",
      source_id: portfolio_id,
      transaction_group_id: txGroupId,
      description: `Wallet-to-portfolio transfer request for ${accountLabel} — awaiting Partner Ops approval`,
      linked_party: "platform",
      // `awaiting_verification` — surfaces in the Partner Ops / Financial Ops
      // verification queue. NO money has moved yet.
      status: "awaiting_verification",
      operation_type: "portfolio_topup",
      metadata: {
        fund_source: "wallet",
        requires_wallet_debit: true,
        requested_at: now,
        requested_wallet_balance: currentBalance,
      },
    });

    if (pendingErr) {
      console.error("[portfolio-topup] Failed to record request:", pendingErr);
      return new Response(JSON.stringify({ error: "Failed to submit transfer request." }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // NO ledger entry, NO wallet deduction, NO principal bump here.
    // Real funds stay in the partner's wallet until Partner Ops approves.
    console.log(`[portfolio-topup] User ${user.id} submitted wallet→portfolio transfer request of ${topupAmount} for ${portfolio_id} — awaiting Partner Ops approval (no funds moved)`);

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
        payload: { title: "📤 Transfer Request Submitted", body: `Your UGX ${topupAmount.toLocaleString()} wallet→portfolio transfer is awaiting Partner Ops approval. No funds have left your wallet yet.`, url: "/dashboard/funder", type: "info" },
      }),
    }).catch(() => {});


    // NOTE: The partnership top-up CONFIRMATION email is intentionally NOT sent
    // here. Funds have not moved yet — the confirmation email is dispatched by
    // `approve-portfolio-topup` once Partner Ops approves the transfer.

    return new Response(JSON.stringify({
      success: true,
      amount: topupAmount,
      status: "awaiting_approval",
      requested: true,
      current_capital: Number(portfolio.investment_amount),
      portfolio_code: portfolio.portfolio_code,
      message: "Transfer request submitted to Partner Ops. Funds stay in your wallet until approved.",
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
