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
    const { amount } = body as { amount?: number };

    if (!amount || typeof amount !== "number" || amount < PRICE_PER_SHARE) {
      return new Response(JSON.stringify({ error: `Minimum investment is UGX ${PRICE_PER_SHARE.toLocaleString()}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(supabaseUrl, serviceKey);

    // Fractional shares: amount / 20,000 (e.g. UGX 50,000 → 2.5 shares).
    const actualAmount = Math.round(amount);
    const shares = Number((actualAmount / PRICE_PER_SHARE).toFixed(6));
    const poolOwnershipPercent = (shares / TOTAL_SHARES) * 100;
    const companyOwnershipPercent = (shares / TOTAL_SHARES) * POOL_PERCENT;

    const { data: poolState } = await adminClient
      .from("angel_pool_investments")
      .select("shares")
      .eq("status", "confirmed");

    const totalSharesSold = (poolState || []).reduce((sum, r) => sum + r.shares, 0);
    if (totalSharesSold + shares > TOTAL_SHARES) {
      return new Response(JSON.stringify({ error: `Only ${TOTAL_SHARES - totalSharesSold} shares remaining` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: wallet } = await adminClient
      .from("wallets")
      .select("id, balance")
      .eq("user_id", user.id)
      .single();

    if (!wallet) {
      return new Response(JSON.stringify({ error: "No wallet found for this account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Pre-check against the SAME strict, ledger-backed figure that
    // create_ledger_transaction enforces. Using the cached wallets.balance
    // column here let users past this gate and into a generic 500.
    const { data: availableRaw, error: availErr } = await adminClient
      .rpc("get_user_available_balance", { p_user_id: user.id });
    if (availErr) throw availErr;
    const available = Number(availableRaw ?? 0);

    if (available < actualAmount) {
      return new Response(JSON.stringify({
        error: `Insufficient available balance. You need UGX ${actualAmount.toLocaleString()} but only UGX ${available.toLocaleString()} is available to invest.`,
      }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    const referenceId = `ANG${yy}${mm}${dd}${seq}`;

    // Balanced RPC: wallet cash_out + platform cash_in (share_capital)
    const txDate = new Date().toISOString();
    const { error: rpcErr } = await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: user.id,
          ledger_scope: 'wallet',
          direction: 'cash_out',
          amount: actualAmount,
          category: 'share_capital',
          source_table: 'angel_pool_investments',
          source_id: wallet.id,
          description: `Angel Pool investment: ${shares} shares @ UGX ${PRICE_PER_SHARE.toLocaleString()}/share`,
          currency: 'UGX',
          reference_id: referenceId,
          transaction_date: txDate,
        },
        {
          user_id: user.id,
          ledger_scope: 'platform',
          direction: 'cash_in',
          amount: actualAmount,
          category: 'share_capital',
          source_table: 'angel_pool_investments',
          source_id: wallet.id,
          description: `Angel Pool share capital received`,
          currency: 'UGX',
          reference_id: referenceId,
          transaction_date: txDate,
        },
      ],
    });

    if (rpcErr) {
      // Balance moved between the pre-check and the posting (or cache drift):
      // surface a readable message instead of a generic 500.
      if (rpcErr.code === "P0001" && /insufficient ledger balance/i.test(rpcErr.message ?? "")) {
        return new Response(JSON.stringify({
          error: `Insufficient available balance to invest UGX ${actualAmount.toLocaleString()}. Please refresh your wallet and try again.`,
        }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      throw rpcErr;
    }

    const { error: investErr } = await adminClient
      .from("angel_pool_investments")
      .insert({
        investor_id: user.id,
        amount: actualAmount,
        shares,
        pool_ownership_percent: poolOwnershipPercent,
        company_ownership_percent: companyOwnershipPercent,
        status: "confirmed",
        reference_id: referenceId,
      });

    if (investErr) throw investErr;

    const { data: updatedWallet } = await adminClient
      .from("wallets")
      .select("balance")
      .eq("user_id", user.id)
      .single();

    await logSystemEvent(adminClient, "angel_pool_investment", user.id, "angel_pool_investments", referenceId, {
      shares, amount: actualAmount, pool_ownership_percent: poolOwnershipPercent,
      company_ownership_percent: companyOwnershipPercent, reference_id: referenceId,
    });

    // Best-effort: send Angel Pool share-purchase confirmation email to first-time investors.
    // Never fails the request — financial transaction is the source of truth.
    try {
      // First-time check: count investor's prior confirmed purchases (excluding the one we just inserted by reference).
      const { count: priorCount } = await adminClient
        .from("angel_pool_investments")
        .select("id", { count: "exact", head: true })
        .eq("investor_id", user.id)
        .eq("status", "confirmed")
        .neq("reference_id", referenceId);

      // Sent on every confirmed purchase (not only the first) with the full shareholding.
      {
        const { data: investorProfile } = await adminClient
          .from("profiles")
          .select("email, full_name")
          .eq("id", user.id)
          .maybeSingle();

        const placeholder = isPlaceholderEmail(investorProfile?.email);

        if (investorProfile?.email && !placeholder) {
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
                funded_by: "investor",
                ...(await getAngelPoolHolding(adminClient, user.id)),
              },
            },
          });
          if (emailErr) console.error("Angel pool email enqueue error:", emailErr);
          await logSystemEvent(adminClient, "angel_pool_email_sent", user.id,
            "angel_pool_investments", referenceId,
            { recipient: investorProfile.email, reference_id: referenceId, first_time: (priorCount ?? 0) === 0 });
        } else if (placeholder) {
          await logSystemEvent(adminClient, "angel_pool_email_skipped", user.id,
            "angel_pool_investments", referenceId,
            { reason: "placeholder_email", recipient: investorProfile?.email ?? null, reference_id: referenceId });
          await recordEmailSkip(adminClient, {
            investorId: user.id, referenceId, recipientEmail: investorProfile?.email ?? null,
            reason: "placeholder_email", fundingSource: "investor", sourceFunction: "angel-pool-invest",
          });
        } else {
          await logSystemEvent(adminClient, "angel_pool_email_skipped", user.id,
            "angel_pool_investments", referenceId,
            { reason: "no_email_on_file", reference_id: referenceId });
          await recordEmailSkip(adminClient, {
            investorId: user.id, referenceId, recipientEmail: null,
            reason: "no_email_on_file", fundingSource: "investor", sourceFunction: "angel-pool-invest",
          });
        }

        // Best-effort SMS confirmation — especially valuable for placeholder /
        // no-email investors who never receive the onboarding email.
        try {
          const smsRes = await sendAngelPoolSms(adminClient, {
            investorId: user.id, shares, amount: actualAmount, referenceId,
          });
          await logSystemEvent(adminClient,
            smsRes.sent ? "angel_pool_sms_sent" : "angel_pool_sms_skipped",
            user.id, "angel_pool_investments", referenceId,
            { reference_id: referenceId, reason: smsRes.reason ?? null });
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
      new_balance: updatedWallet?.balance ?? 0,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("angel-pool-invest error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
