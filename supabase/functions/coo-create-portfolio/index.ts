import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipAgreementRequest, buildPartnerCompoundCreationRequest, dispatchTransactionalEmail } from "../_shared/partnership-emails.ts";
import { withRetry } from "../_shared/rpcRetry.ts";
import { isValidInvestmentAmount, MIN_INVESTMENT_ERROR } from "../_shared/investmentAmount.ts";
import {
  callerIsPartnerStaff,
  formatRatePct,
  monthlyReturnFor,
  POLICY_CHANGED_RESPONSE,
  RATE_NOTE_FOR_OTHER_STAFF,
  rateAwaitsCfo,
  rateEmailTarget,
  rowRateIsPublic,
  readConfirmedLoginEmails,
  storedRate,
  typedRate,
  typedRateNeedsReload,
} from "../_shared/partnerReturnPolicy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization header" }, 401);
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
    if (callerError || !caller) return json({ error: "Unauthorized" }, 401);

    // Built per request with the caller as x-welile-actor, so a typed rate the gate queues for the
    // CFO records who typed it (trg_portfolio_rate_requests_stamp_actor; service role only).
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { "x-welile-actor": caller.id } },
      auth: { persistSession: false },
    });

    // COO/Manager/Partner-Ops guard
    const [{ data: managerRoles, error: roleErr }, { data: staffPerms, error: permErr }] = await Promise.all([
      adminClient.from("user_roles").select("role")
        .eq("user_id", caller.id).in("role", ["manager", "coo", "super_admin", "cto"]),
      adminClient.from("staff_permissions").select("permitted_dashboard")
        .eq("user_id", caller.id).eq("permitted_dashboard", "partner-ops"),
    ]);
    if (roleErr) {
      console.error("[coo-create-portfolio] Role lookup error:", roleErr.message);
      return json({ error: `Role check failed: ${roleErr.message}` }, 500);
    }
    if (permErr) {
      console.error("[coo-create-portfolio] Staff permission lookup error:", permErr.message);
      return json({ error: `Permission check failed: ${permErr.message}` }, 500);
    }
    const hasRole = (managerRoles?.length ?? 0) > 0;
    const hasPartnerOps = (staffPerms?.length ?? 0) > 0;
    if (!hasRole && !hasPartnerOps) {
      console.warn(`[coo-create-portfolio] Caller ${caller.id} blocked — no manager/coo/super_admin/cto role and no partner-ops permission`);
      return json({ error: "Only Welile Operations (COO, Manager, Super Admin, Partner Ops) can perform this action" }, 403);
    }

    const body = await req.json() as {
      partner_id: string;
      amount: number;
      /** Optional: a typed rate. Omitted -> the database gate stores the partner's own rate. */
      roi_percentage?: number | string | null;
      roi_mode: "monthly_payout" | "monthly_compounding";
      duration_months: number;
      contribution_date?: string | null;     // YYYY-MM-DD or ISO
      payment_method: "wallet" | "proxy_agent";
      source_wallet_user_id: string;         // partner id OR proxy agent id
      policy_enabled_seen?: boolean;
    };

    // Validate
    const typed = typedRate(body.roi_percentage);
    if (!body.partner_id || !UUID.test(body.partner_id)) return json({ error: "Invalid partner ID" }, 400);
    if (!body.source_wallet_user_id || !UUID.test(body.source_wallet_user_id)) return json({ error: "Invalid source wallet" }, 400);
    if (!isValidInvestmentAmount(body.amount)) return json({ error: MIN_INVESTMENT_ERROR }, 400);
    if (typed === "invalid") return json({ error: "Monthly Returns rate must be above 0% and at most 100%" }, 400);
    if (!body.duration_months || body.duration_months < 1 || body.duration_months > 60) return json({ error: "Duration must be 1-60 months" }, 400);
    if (!["monthly_payout", "monthly_compounding"].includes(body.roi_mode)) return json({ error: "Invalid Returns mode" }, 400);
    if (!["wallet", "proxy_agent"].includes(body.payment_method)) return json({ error: "Invalid payment method" }, 400);

    // A screen that typed a rate without seeing the switch on is stale once it is on (409, before any
    // money moves).
    if (await typedRateNeedsReload(adminClient, typed !== null, body.policy_enabled_seen)) {
      return json(POLICY_CHANGED_RESPONSE, 409);
    }

    // Verify partner is supporter
    const { data: partnerRole } = await adminClient
      .from("user_roles").select("id")
      .eq("user_id", body.partner_id).eq("role", "supporter").maybeSingle();
    if (!partnerRole) return json({ error: "Selected user is not a registered partner/supporter" }, 400);

    // ── PORTFOLIO CREATION FUNDS ALWAYS COME FROM THE PARTNER WALLET ──
    // Even when the partner is managed by a proxy agent, the principal for a
    // NEW portfolio MUST be debited from the partner's own wallet — never the
    // proxy agent's wallet. Proxy wallets are only involved in payout routing
    // (ROI), not in funding portfolio creation. We force the source here so
    // legacy UI paths that still send `proxy_agent` cannot debit the proxy.
    if (body.payment_method !== "wallet" || body.source_wallet_user_id !== body.partner_id) {
      console.warn(
        `[coo-create-portfolio] Forcing partner-wallet funding: partner=${body.partner_id} ` +
        `was method=${body.payment_method} source=${body.source_wallet_user_id}`,
      );
    }
    body.payment_method = "wallet";
    body.source_wallet_user_id = body.partner_id;

    // Check source wallet balance
    const { data: sourceWallet, error: walletErr } = await adminClient
      .from("wallets").select("id, balance")
      .eq("user_id", body.source_wallet_user_id).single();
    if (walletErr || !sourceWallet) return json({ error: "Source wallet not found" }, 404);
    if (Number(sourceWallet.balance) < body.amount) {
      return json({ error: `Insufficient balance. Available: UGX ${Number(sourceWallet.balance).toLocaleString()}` }, 400);
    }

    // Names for ledger description
    const [partnerProfileRes, sourceProfileRes] = await Promise.all([
      adminClient.from("profiles").select("full_name").eq("id", body.partner_id).single(),
      adminClient.from("profiles").select("full_name").eq("id", body.source_wallet_user_id).single(),
    ]);
    const partnerName = partnerProfileRes.data?.full_name || "Partner";
    const sourceName = sourceProfileRes.data?.full_name || (body.payment_method === "proxy_agent" ? "Proxy Agent" : partnerName);

    // ── Funder verification gate (BEFORE any money moves) ──
    // Self-registered funders (signup_source = 'funder-onboarding') must be
    // approved by Partner Ops / COO before a portfolio can be created.
    // The DB trigger enforce_funder_verified_for_portfolio also blocks this,
    // but that fires AFTER the wallet is debited — leaving funds stranded and
    // surfacing a cryptic "Edge Function" error. Check here first so we never
    // deduct money and return a clear, plain-language reason.
    {
      const { data: funderProfile } = await adminClient
        .from("profiles")
        .select("signup_source, funder_verified_at")
        .eq("id", body.partner_id)
        .maybeSingle();
      if (funderProfile?.signup_source === "funder-onboarding" && !funderProfile?.funder_verified_at) {
        return json({
          error: `${partnerName} self-registered and is not yet verified. Approve them in Partner Ops (Verify Funder) before creating or topping up a portfolio.`,
        }, 400);
      }
    }

    // Reference + dates
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    const referenceId = `WIP${yy}${mm}${dd}${seq}`;

    const contributionDate = body.contribution_date ? new Date(body.contribution_date) : now;
    if (isNaN(contributionDate.getTime())) return json({ error: "Invalid contribution date" }, 400);

    const payoutDay = Math.min(contributionDate.getDate(), 28);
    const maturityDate = new Date(contributionDate);
    maturityDate.setMonth(maturityDate.getMonth() + body.duration_months);
    const nextRoiDate = new Date(contributionDate);
    nextRoiDate.setMonth(nextRoiDate.getMonth() + 1);

    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const opStartedAt = Date.now();
    const isLargeAmount = body.amount >= 5_000_000;
    if (isLargeAmount) {
      console.log(
        `[coo-create-portfolio] LARGE op start partner=${body.partner_id} ` +
        `amount=${body.amount} method=${body.payment_method} source=${body.source_wallet_user_id} ref=${referenceId}`,
      );
    }

    // ── Deduct from selected wallet via balanced ledger RPC ──
    // Uses 'partner_funding' (allowlisted) — same pattern as coo-invest-for-partner.
    // Wrapped in bounded retry — large amounts (10M+) occasionally hit
    // transient pooler/connection failures and surface as user-facing
    // "Edge Function returned non-2xx". Insufficient-balance and other
    // validation errors are NOT retried (filtered inside withRetry).
    const ledgerRes = await withRetry<string>(
      "create_portfolio_ledger",
      referenceId,
      () => adminClient.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: body.source_wallet_user_id,
          amount: body.amount,
          direction: "cash_out",
          category: "partner_funding",
          ledger_scope: "wallet",
          source_table: "wallets",
          description: `Welile Operations created portfolio ${referenceId} for ${partnerName} — UGX ${body.amount.toLocaleString()} debited from ${sourceName}'s ${body.payment_method === "proxy_agent" ? "proxy-agent" : "partner"} wallet. Payout day: ${payoutDay}`,
          currency: "UGX",
          reference_id: referenceId,
          linked_party: "Rent Management Pool",
          transaction_date: contributionDate.toISOString(),
        },
        {
          direction: "cash_in",
          amount: body.amount,
          category: "partner_funding",
          ledger_scope: "platform",
          source_table: "wallets",
          description: `Rent Management Pool received UGX ${body.amount.toLocaleString()} from ${partnerName}${body.payment_method === "proxy_agent" ? ` (via proxy agent ${sourceName})` : ""} — portfolio ${referenceId}`,
          currency: "UGX",
          reference_id: referenceId,
          linked_party: partnerName,
          transaction_date: contributionDate.toISOString(),
        },
      ],
      }),
    );
    const txGroupId = ledgerRes.data;
    const ledgerErr = ledgerRes.error as { message?: string } | null;

    if (ledgerErr) {
      console.error(
        `[coo-create-portfolio] Ledger RPC failed for ${referenceId} after ${ledgerRes.attempts} attempts (${ledgerRes.ms}ms):`,
        ledgerErr.message,
      );
      // Insufficient-balance is a user-correctable validation error, not a runtime crash.
      // Return 400 with a friendly message so the caller toasts cleanly instead of
      // bubbling a 500 / blank-screen runtime overlay.
      const raw = ledgerErr.message || "";
      const isInsufficient = /insufficient ledger balance/i.test(raw);
      if (isInsufficient) {
        const m = raw.match(/Available:\s*(\d+).*?Required:\s*(\d+)/i);
        const available = m ? Number(m[1]).toLocaleString() : null;
        const required = m ? Number(m[2]).toLocaleString() : null;
        const friendly = available && required
          ? `Insufficient funds in ${sourceName}'s ${body.payment_method === "proxy_agent" ? "proxy-agent" : "partner"} wallet. Available: UGX ${available} · Required: UGX ${required}. Top up the wallet and try again.`
          : `Insufficient funds in ${sourceName}'s wallet. Top up and try again.`;
        return json({ error: friendly }, 400);
      }
      return json({ error: `Failed to deduct funds: ${raw}` }, 500);
    }

    // Belt-and-braces: re-derive bucket balances from ledger truth so the
    // withdrawable_balance bucket stays in sync with the just-posted debit.
    // Without this, ledger trigger updates `balance` but the per-bucket fields
    // can drift if the bucket router ever misses a category.
    const recomputeRes = await withRetry<unknown>(
      "recompute_wallet_buckets",
      referenceId,
      () => adminClient.rpc("recompute_wallet_buckets", { p_user_id: body.source_wallet_user_id }),
    );
    const recomputeErr = recomputeRes.error as { message?: string } | null;
    if (recomputeErr) {
      console.warn(`[coo-create-portfolio] Bucket recompute failed for ${body.source_wallet_user_id} (non-blocking):`, recomputeErr.message);
    }

    // ── Create the portfolio AFTER successful deduction ──
    const portfolioPin = String(Math.floor(1000 + Math.random() * 9000));
    const { data: portfolio, error: portfolioErr } = await adminClient
      .from("investor_portfolios")
      .insert({
        investor_id: body.partner_id,
        agent_id: body.partner_id,
        portfolio_code: referenceId,
        investment_amount: body.amount,
        // Rate only when typed; otherwise the gate stores the partner's own rate.
        ...(typed !== null ? { roi_percentage: typed } : {}),
        roi_mode: body.roi_mode,
        total_roi_earned: 0,
        status: "active",
        duration_months: body.duration_months,
        payout_day: payoutDay,
        next_roi_date: fmt(nextRoiDate),
        maturity_date: fmt(maturityDate),
        auto_reinvest: false,
        portfolio_pin: portfolioPin,
        activation_token: crypto.randomUUID(),
        created_at: contributionDate.toISOString(),
      })
      .select("id, roi_percentage, rate_basis")
      .single();

    if (portfolioErr) {
      console.error("[coo-create-portfolio] Portfolio insert failed:", portfolioErr.message);
      return json({ error: `Funds were deducted but portfolio record failed. Contact Ops with ref ${referenceId}. Error: ${portfolioErr.message}` }, 500);
    }

    // The rate the gate stored (a typed rate that differs waits for the CFO), and whether it applies
    // to everyone (read from the row).
    const stored = storedRate(portfolio);
    const rateIsPublic = await rowRateIsPublic(adminClient, portfolio);

    // Audit log
    await adminClient.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "create_manual_portfolio",
      table_name: "investor_portfolios",
      record_id: portfolio.id,
      metadata: {
        partner_id: body.partner_id,
        partner_name: partnerName,
        investment_amount: body.amount,
        roi_percentage: stored,
        requested_roi_percentage: typed,
        roi_mode: body.roi_mode,
        duration_months: body.duration_months,
        portfolio_code: referenceId,
        reference_id: referenceId,
        payment_method: body.payment_method,
        source_wallet_user_id: body.source_wallet_user_id,
        source_name: sourceName,
        tx_group_id: txGroupId,
      },
    });

    // Notify partner
    const monthlyReward = monthlyReturnFor(body.amount, stored);
    await adminClient.from("notifications").insert({
      user_id: body.partner_id,
      title: "🎉 New Portfolio Created",
      message: stored !== null && monthlyReward !== null
        ? `A portfolio of UGX ${body.amount.toLocaleString()} was created for you (${referenceId}). You'll earn ${formatRatePct(stored)} (UGX ${monthlyReward.toLocaleString()}) per month. First payout: ${fmt(nextRoiDate)}.`
        : `A portfolio of UGX ${body.amount.toLocaleString()} was created for you (${referenceId}). Your monthly Returns are shown on your dashboard. First payout: ${fmt(nextRoiDate)}.`,
      type: "success",
      metadata: {
        reference_id: referenceId,
        amount: body.amount,
        ...(monthlyReward !== null ? { monthly_reward: monthlyReward } : {}),
      },
    });

    console.log(`[coo-create-portfolio] ${caller.id} created portfolio ${referenceId} for partner ${body.partner_id}, source=${body.payment_method}, amt=${body.amount}`);
    if (isLargeAmount) {
      console.log(
        `[coo-create-portfolio] LARGE op done ref=${referenceId} amount=${body.amount} ` +
        `total_ms=${Date.now() - opStartedAt}`,
      );
    }

    // Partnership Agreement email — fire-and-forget, target = partner (not the COO actor). It carries
    // the rate and monthly Returns: the profile email when the row's rate applies to everyone (switch
    // off, as before); otherwise the confirmed login email, or the profile email without figures (D4).
    try {
      const [{ data: partnerProfile }, loginEmails] = await Promise.all([
        adminClient.from("profiles").select("email, full_name").eq("id", body.partner_id).maybeSingle(),
        rateIsPublic ? null : readConfirmedLoginEmails(adminClient, [body.partner_id]),
      ]);
      const target = rateEmailTarget(loginEmails?.get(body.partner_id) ?? null, partnerProfile?.email ?? null, rateIsPublic);
      const figureRate = target.withFigures ? stored : null;
      if (target.to) {
        dispatchTransactionalEmail(
          supabaseUrl,
          supabaseServiceKey,
          body.roi_mode === "monthly_compounding"
            ? buildPartnerCompoundCreationRequest({
                recipientEmail: target.to,
                partnerName: partnerProfile?.full_name || partnerName,
                partnerId: body.partner_id,
                portfolioId: portfolio.id,
                initialAmount: body.amount,
                roiPercentage: figureRate,
                contributionDateIso: contributionDate.toISOString(),
              })
            : buildPartnershipAgreementRequest({
                recipientEmail: target.to,
                partnerName: partnerProfile?.full_name || partnerName,
                partnerId: body.partner_id,
                portfolioId: portfolio.id,
                amount: body.amount,
                monthlyReward: target.withFigures ? monthlyReward : null,
                contributionDateIso: contributionDate.toISOString(),
                firstPayoutDateIso: fmt(nextRoiDate),
                payoutDay,
                roiPercentage: figureRate,
              }),
          "coo-create-portfolio",
        );
      }
    } catch (emailErr) {
      console.warn("[coo-create-portfolio] Email lookup failed (non-blocking):", emailErr);
    }

    // Stored rates go back to partner staff (D11; cto is not partner staff), or to any permitted
    // caller when the row's rate applies to everyone (switch off).
    const showRates = rateIsPublic || await callerIsPartnerStaff(adminClient, caller.id);
    return json({
      success: true,
      portfolio_id: portfolio.id,
      portfolio_code: referenceId,
      reference_id: referenceId,
      tx_group_id: txGroupId,
      ...(showRates
        ? { roi_percentage: stored, requested_roi_percentage: typed, rate_awaits_cfo: rateAwaitsCfo(typed, stored) }
        : { rate_note: RATE_NOTE_FOR_OTHER_STAFF }),
    }, 200);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[coo-create-portfolio] Error:", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
