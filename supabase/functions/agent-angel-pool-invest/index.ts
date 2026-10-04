import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { isPlaceholderEmail, sendAngelPoolSms, recordEmailSkip } from "../_shared/angelPoolNotify.ts";
import { getAngelPoolHolding } from "../_shared/angelPoolHolding.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const TOTAL_SHARES = 25_000;
const PRICE_PER_SHARE = 20_000;
const POOL_PERCENT = 8;
const AGENT_COMMISSION_RATE = 0.01;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json().catch(() => ({}));
    const { investor_id, amount, payment_method, investment_reference, funding_source, investment_date } = body as {
      investor_id?: string; amount?: number; payment_method?: string;
      investment_reference?: string; funding_source?: string; investment_date?: string;
    };
    const fundingSource: 'investor' | 'agent' =
      funding_source === 'agent' ? 'agent' : 'investor';

    if (!investor_id || typeof investor_id !== "string") {
      return new Response(JSON.stringify({ error: "investor_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!amount || typeof amount !== "number" || amount < PRICE_PER_SHARE) {
      return new Response(JSON.stringify({ error: `Minimum investment is UGX ${PRICE_PER_SHARE.toLocaleString()}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!investment_date || !/^\d{4}-\d{2}-\d{2}$/.test(investment_date)) {
      return new Response(JSON.stringify({ error: "investment_date is required (YYYY-MM-DD)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(supabaseUrl, serviceKey);

    const { data: agentRole } = await adminClient
      .from("user_roles").select("role")
      .eq("user_id", user.id).eq("role", "agent").maybeSingle();
    if (!agentRole) {
      return new Response(JSON.stringify({ error: "Only agents can use this function" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fractional shares: amount / 20,000 (e.g. UGX 50,000 → 2.5 shares).
    // actualAmount equals the entered amount; DB trigger enforces shares*20000 ≈ amount.
    const actualAmount = Math.round(amount);
    const shares = Number((actualAmount / PRICE_PER_SHARE).toFixed(6));
    const poolOwnershipPercent = (shares / TOTAL_SHARES) * 100;
    const companyOwnershipPercent = (shares / TOTAL_SHARES) * POOL_PERCENT;

    const { data: poolState } = await adminClient
      .from("angel_pool_investments").select("shares").eq("status", "confirmed");
    const totalSharesSold = (poolState || []).reduce((sum: number, r: any) => sum + r.shares, 0);
    if (totalSharesSold + shares > TOTAL_SHARES) {
      return new Response(JSON.stringify({ error: `Only ${TOTAL_SHARES - totalSharesSold} shares remaining` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Resolve funding user (the wallet that pays) — defaults to investor for backward compat.
    const fundingUserId = fundingSource === 'agent' ? user.id : investor_id;

    // Strict withdrawable balance check via canonical RPC (never trusts cached wallet.balance).
    const { data: availableBalance, error: balErr } = await adminClient
      .rpc('get_user_available_balance', { p_user_id: fundingUserId });
    if (balErr) {
      return new Response(JSON.stringify({ error: `Failed to verify wallet balance: ${balErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const fundingBalance = Number(availableBalance) || 0;
    if (fundingBalance < actualAmount) {
      return new Response(JSON.stringify({
        error: `Insufficient ${fundingSource === 'agent' ? 'agent' : 'investor'} wallet balance (available: UGX ${fundingBalance.toLocaleString()})`,
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Reuse investor wallet id only as a source_id reference for ledger entries.
    const { data: investorWallet } = await adminClient
      .from("wallets").select("id").eq("user_id", investor_id).single();

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    const referenceId = `ANG${yy}${mm}${dd}${seq}`;

    // Anchor ledger + email to the agent-supplied investment date (midday UTC to avoid TZ drift).
    const txDate = new Date(`${investment_date}T12:00:00.000Z`).toISOString();

    // 1. Investment: wallet cash_out (from funding user) + platform cash_in (share_capital)
    const { error: investRpcErr } = await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: fundingUserId, ledger_scope: 'wallet', direction: 'cash_out',
          amount: actualAmount, category: 'angel_pool_investment',
          source_table: 'angel_pool_investments', source_id: investorWallet?.id ?? null,
          description: `Angel Pool investment: ${shares} shares @ UGX ${PRICE_PER_SHARE.toLocaleString()}/share (via agent, funded_by=${fundingSource}, beneficiary=${investor_id})`,
          currency: 'UGX', reference_id: referenceId, transaction_date: txDate,
        },
        {
          user_id: investor_id, ledger_scope: 'platform', direction: 'cash_in',
          amount: actualAmount, category: 'pool_capital_received',
          source_table: 'angel_pool_investments', source_id: investorWallet?.id ?? null,
          description: `Angel Pool share capital received via agent (funded_by=${fundingSource})`,
          currency: 'UGX', reference_id: referenceId, transaction_date: txDate,
        },
      ],
    });
    if (investRpcErr) throw investRpcErr;

    // Insert investment record
    const { error: investErr } = await adminClient
      .from("angel_pool_investments")
      .insert({
        investor_id, amount: actualAmount, shares,
        pool_ownership_percent: poolOwnershipPercent,
        company_ownership_percent: companyOwnershipPercent,
        status: "confirmed", reference_id: referenceId,
        agent_id: user.id, payment_method: payment_method || null,
        investment_reference: investment_reference || null,
        funded_by: fundingSource,
      });
    if (investErr) throw investErr;

    // 2. Agent commission: platform cash_out + wallet cash_in (agent_commission_earned)
    const commission = Math.floor(actualAmount * AGENT_COMMISSION_RATE);
    if (commission > 0) {
      const { error: commErr } = await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: user.id, ledger_scope: 'platform', direction: 'cash_out',
            amount: commission, category: 'agent_commission_earned',
            source_table: 'angel_pool_investments', source_id: investorWallet.id,
            description: `Angel Pool agent commission expense (1%) for ${referenceId}`,
            currency: 'UGX', reference_id: referenceId, transaction_date: txDate,
          },
          {
            user_id: user.id, ledger_scope: 'wallet', direction: 'cash_in',
            amount: commission, category: 'agent_commission_earned',
            source_table: 'angel_pool_investments', source_id: investorWallet.id,
            description: `Angel Pool agent commission (1%) for ${referenceId}`,
            currency: 'UGX', reference_id: referenceId, transaction_date: txDate,
          },
        ],
      });
      if (commErr) console.error("Commission RPC error:", commErr);
    }

    const { data: updatedWallet } = await adminClient
      .from("wallets").select("balance").eq("user_id", investor_id).single();

    await logSystemEvent(adminClient, "agent_angel_pool_investment", user.id, "angel_pool_investments", referenceId, {
      investor_id, shares, amount: actualAmount, commission, reference_id: referenceId,
      funded_by: fundingSource, funding_user_id: fundingUserId,
    });

    // Best-effort: send share-purchase confirmation email to the investor.
    // Only sent on the investor's FIRST confirmed Angel Pool purchase.
    // Never fails the request — financial transaction is the source of truth.
    try {
      const { count: priorCount } = await adminClient
        .from("angel_pool_investments")
        .select("id", { count: "exact", head: true })
        .eq("investor_id", investor_id)
        .eq("status", "confirmed")
        .neq("reference_id", referenceId);

      // Sent on every confirmed purchase (not only the first) with the full shareholding.
      {
      const { data: investorProfile } = await adminClient
        .from("profiles")
        .select("email, full_name")
        .eq("id", investor_id)
        .maybeSingle();

      if (investorProfile?.email) {
        const placeholder = isPlaceholderEmail(investorProfile.email);
        if (!placeholder) {
        // Recompute available shares post-insert for accuracy.
        const { data: postPool } = await adminClient
          .from("angel_pool_investments")
          .select("shares")
          .eq("status", "confirmed");
        const sold = (postPool || []).reduce((s: number, r: any) => s + r.shares, 0);
        const availableShares = Math.max(0, TOTAL_SHARES - sold);

        const purchaseDate = new Date(txDate).toLocaleDateString("en-GB", {
          day: "2-digit", month: "long", year: "numeric",
        });

        const { error: emailErr } = await adminClient.functions.invoke("send-transactional-email", {
          body: {
            templateName: "angel-pool-share-purchase",
            recipientEmail: investorProfile.email,
            idempotencyKey: `angel-pool-${referenceId}`,
            templateData: {
              partner_name: investorProfile.full_name || "Partner",
              pool_name: "Welile Angel Pool",
              share_reference: referenceId,
              shares_purchased: shares,
              currency: "UGX",
              investment_amount: actualAmount,
              ownership_percentage: companyOwnershipPercent.toFixed(4),
              price_per_share: PRICE_PER_SHARE,
              pool_valuation: TOTAL_SHARES * PRICE_PER_SHARE,
              purchase_date: purchaseDate,
              total_pool_shares: TOTAL_SHARES,
              available_shares: availableShares,
              pool_percentage: POOL_PERCENT,
              pool_round: "Seed Round",
              company_name: "Welile",
              funded_by: fundingSource,
              ...(await getAngelPoolHolding(adminClient, investor_id)),
            },
          },
        });
        if (emailErr) console.error("Angel pool email enqueue error:", emailErr);
        await logSystemEvent(adminClient, "agent_angel_pool_email_sent", user.id,
          "angel_pool_investments", referenceId,
          { investor_id, recipient: investorProfile.email, reference_id: referenceId });
        } else {
          await logSystemEvent(adminClient, "agent_angel_pool_email_skipped", user.id,
            "angel_pool_investments", referenceId,
            { investor_id, reason: "placeholder_email", recipient: investorProfile.email, reference_id: referenceId });
          await recordEmailSkip(adminClient, {
            investorId: investor_id, referenceId, recipientEmail: investorProfile.email,
            reason: "placeholder_email", fundingSource: fundingSource, sourceFunction: "agent-angel-pool-invest",
          });
        }
      } else {
        await logSystemEvent(adminClient, "agent_angel_pool_email_skipped", user.id,
          "angel_pool_investments", referenceId,
          { investor_id, reason: "no_email_on_file", reference_id: referenceId });
        await recordEmailSkip(adminClient, {
          investorId: investor_id, referenceId, recipientEmail: null,
          reason: "no_email_on_file", fundingSource: fundingSource, sourceFunction: "agent-angel-pool-invest",
        });
      }

      // Best-effort SMS confirmation to the investor — works even when the
      // email is a placeholder or missing entirely.
      try {
        const smsRes = await sendAngelPoolSms(adminClient, {
          investorId: investor_id, shares, amount: actualAmount, referenceId,
        });
        await logSystemEvent(adminClient,
          smsRes.sent ? "agent_angel_pool_sms_sent" : "agent_angel_pool_sms_skipped",
          user.id, "angel_pool_investments", referenceId,
          { investor_id, reference_id: referenceId, reason: smsRes.reason ?? null });
      } catch (smsEx) {
        console.error("Angel pool SMS dispatch failed:", smsEx);
      }
      }
    } catch (emailEx) {
      console.error("Angel pool email dispatch failed:", emailEx);
    }

    return new Response(JSON.stringify({
      success: true, reference_id: referenceId, shares, actual_amount: actualAmount,
      pool_ownership_percent: poolOwnershipPercent, company_ownership_percent: companyOwnershipPercent,
      commission, investor_new_balance: updatedWallet?.balance ?? 0,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("agent-angel-pool-invest error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
