// Partner Ops → creates either:
// 1) an inert invite portfolio for an EXISTING partner and emails a secure
//    one-tap link to complete missing details + sign, OR
// 2) a direct-confirmation first portfolio that immediately debits the
//    partner wallet, activates the portfolio, and sends the final confirmation.
//
// Invite mode: the partner wallet is ALWAYS debited at portfolio creation
// (idempotency key `portfolio-funding-<id>`). The portfolio then sits at
// status='awaiting_partner_details' until the partner completes it, then
// flips to 'pending_ops_approval'. Ops approves via approve-pending-portfolio,
// which flips it to 'active' and dispatches the existing partnership-agreement
// email. approve-pending-portfolio detects the existing debit and skips
// re-charging.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipAgreementRequest, dispatchTransactionalEmail } from "../_shared/partnership-emails.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { withRetry } from "../_shared/rpcRetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addMonthsIsoDate(iso: string, months: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Cryptographically strong URL-safe token
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !caller) return json({ error: "Unauthorized" }, 401);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const partnerId = String(body?.partner_id || "");
    const amount = Number(body?.amount);
    const durationMonths = Number(body?.duration_months);
    const roiPercentage = Number(body?.roi_percentage);
    const roiMode = String(body?.roi_mode || "monthly_payout");
    const nickname = body?.nickname ? String(body.nickname).slice(0, 120) : null;
    // When true → skip the invite link email and instead immediately approve
    // the portfolio + send the standard Tenant Partnership Confirmation.
    // Only allowed for partners that currently have NO portfolios.
    let directConfirmation = body?.direct_confirmation === true;

    if (!UUID.test(partnerId)) return json({ error: "Invalid partner ID" }, 400);
    if (!Number.isFinite(amount) || amount < 20000) return json({ error: "Amount must be at least UGX 20,000" }, 400);
    if (!Number.isFinite(durationMonths) || durationMonths < 1 || durationMonths > 60) {
      return json({ error: "Duration must be between 1 and 60 months" }, 400);
    }
    if (!Number.isFinite(roiPercentage) || roiPercentage <= 0 || roiPercentage > 100) {
      return json({ error: "ROI % must be between 0 and 100" }, 400);
    }
    if (!["monthly_payout", "monthly_compounding"].includes(roiMode)) {
      return json({ error: "Invalid ROI mode" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const guardBlock = await checkTreasuryGuard(admin, "any", authHeader);
    if (guardBlock) return guardBlock;

    // Look up partner contact info up-front so we can email them.
    const { data: partner, error: partnerErr } = await admin
      .from("profiles")
      .select("id, full_name, email, phone, frozen_at")
      .eq("id", partnerId)
      .maybeSingle();
    if (partnerErr) return json({ error: `Partner lookup failed: ${partnerErr.message}` }, 500);
    if (!partner) return json({ error: "Partner not found" }, 404);
    if ((partner as any).frozen_at) {
      return json({
        error: "This partner's account is suspended. Unfreeze the account before creating a new portfolio.",
      }, 403);
    }
    if (!partner.email) {
      return json({ error: "Partner has no email on file — add one before sending an invite." }, 400);
    }

    // Verify the user is a partner: either explicitly tagged as supporter or
    // already holding an investor portfolio from the legacy onboarding flow.
    const [{ data: role }, { data: existingPortfolio }] = await Promise.all([
      admin
        .from("user_roles").select("id")
        .eq("user_id", partnerId).eq("role", "supporter").maybeSingle(),
      admin
        .from("investor_portfolios").select("id")
        .eq("investor_id", partnerId).limit(1).maybeSingle(),
    ]);
    if (!role && !existingPortfolio) {
      return json({ error: "Selected user is not a registered partner" }, 400);
    }

    // Auto-upgrade FIRST portfolio to direct confirmation: partner details
    // were captured at funder-onboarding, so there is nothing for the partner
    // to complete. Anything after the first portfolio still follows whatever
    // the caller requested (invite by default).
    if (!existingPortfolio) {
      directConfirmation = true;
    }

    // Note: direct_confirmation is now allowed for ANY approved partner,
    // including those with existing portfolios. Every new portfolio must
    // debit the partner wallet at creation — the previous "invite fallthrough"
    // for existing partners left wallets credited but never debited
    // (see backfill 2026-07-24 for ISAAC / PAMELA / Mbakureeba Joshua).

    // Funding source = OPERATIONAL FLOAT (never withdrawable).
    // See mem://business-model/self-support-float-funding — partner portfolio
    // principal is deployed company float, not the partner's cash-out money.
    {
      const { data: floatAvailRaw, error: availErr } = await admin.rpc("funder_float_available", {
        p_user_id: partnerId,
      });
      if (availErr) {
        console.error("[create-portfolio-invite] float balance lookup failed:", availErr);
        return json({ error: "Could not verify partner operational float. Please retry." }, 500);
      }

      const floatAvail = Number(floatAvailRaw ?? 0);
      if (floatAvail < amount) {
        return json({
          error: `Insufficient partner operational float. Need UGX ${amount.toLocaleString()}, but only UGX ${floatAvail.toLocaleString()} of float is available.`,
        }, 400);
      }
    }


    const rawToken = generateToken();

    // RPC creates the pending portfolio + hashed token in one transactional step.
    // It also runs the Ops-role guard server-side.
    const { data: rpcData, error: rpcErr } = await userClient.rpc("create_pending_portfolio", {
      p_partner_id: partnerId,
      p_amount: amount,
      p_duration_months: durationMonths,
      p_roi_percentage: roiPercentage,
      p_roi_mode: roiMode,
      p_nickname: nickname,
      p_raw_token: rawToken,
    });
    if (rpcErr) {
      const msg = rpcErr.message || "";
      if (msg.includes("NOT_AUTHORIZED")) {
        return json({ error: "You do not have permission to create portfolios." }, 403);
      }
      if (msg.includes("PARTNER_MISSING_CONTACT")) {
        return json({ error: "Partner has no email or phone on file." }, 400);
      }
      if (msg.includes("self_registered_funder_not_verified")) {
        return json({
          error:
            "This partner signed themselves up and has not been verified yet. Approve them in Partner Ops → Partner Onboarding (verification queue) first, then create the portfolio.",
        }, 400);
      }
      if (msg.includes("INVALID_")) {
        return json({ error: "Portfolio details invalid — please review the form." }, 400);
      }
      return json({ error: `Could not create pending portfolio: ${msg}` }, 500);
    }

    const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    const portfolioId = row?.portfolio_id;
    const portfolioCode = row?.portfolio_code;

    // ── Debit partner wallet at creation ──────────────────────────────────
    // Runs for BOTH invite and direct-confirmation branches, using the same
    // idempotency key that approve-pending-portfolio checks for, so the later
    // approval step becomes a no-op on the ledger side.
    const fundingIdempotencyKey = `portfolio-funding-${portfolioId}`;
    const fundingLedgerRes = await withRetry<unknown>(
      "portfolio_funding_on_creation",
      portfolioId,
      () => admin.rpc("create_ledger_transaction", {
        idempotency_key: fundingIdempotencyKey,
        entries: [
          {
            user_id: partnerId,
            amount,
            direction: "cash_out",
            category: "partner_funding",
            ledger_scope: "wallet",
            recipient_type: "operational_wallet",
            wallet_bucket: "float",
            description: `Operational float deployed to portfolio ${portfolioCode} (float_usage=partner_portfolio_funding)`,
            source_table: "investor_portfolios",
            source_id: portfolioId,
            reference_id: portfolioCode,
            linked_party: "platform",
          },

          {
            amount,
            direction: "cash_in",
            category: "partner_funding",
            ledger_scope: "platform",
            description: `Platform capital received for portfolio ${portfolioCode}`,
            source_table: "investor_portfolios",
            source_id: portfolioId,
            reference_id: portfolioCode,
            linked_party: partnerId,
          },
        ],
      }),
    );
    const fundingLedgerErr = fundingLedgerRes.error as { message?: string } | null;
    if (fundingLedgerErr) {
      console.error("[create-portfolio-invite] creation-time wallet debit failed:", fundingLedgerErr);
      // Roll the pending portfolio back so we don't leave a phantom row.
      await admin.from("investor_portfolios").delete().eq("id", portfolioId);
      return json({
        error: `Wallet deduction failed: ${fundingLedgerErr.message || "unknown error"}. Portfolio was not created.`,
      }, 500);
    }
    const fundingTxGroupId = String(fundingLedgerRes.data || "");

    // Mirror to wallet_transactions for the partner's activity feed.
    const { error: wtErr } = await admin.from("wallet_transactions").insert({
      sender_id: partnerId,
      recipient_id: partnerId,
      amount,
      description: `Portfolio funded: ${portfolioCode}`,
    });
    if (wtErr && (wtErr as any).code !== "23505") {
      console.warn("[create-portfolio-invite] wallet transaction insert failed:", wtErr);
    }

    // Build the completion URL. Origin comes from the request so the same
    // function works in preview + production without extra config.
    const origin = req.headers.get("origin") || "https://welileapp.com";
    const completionUrl =
      `${origin}/partners/${partnerId}/portfolios/${portfolioId}/complete?token=${encodeURIComponent(rawToken)}`;

    // ── Direct confirmation branch ────────────────────────────────────────
    // Approve the freshly-created portfolio right away and send the standard
    // Tenant Partnership Confirmation email. No invite link is sent.
    if (directConfirmation) {
      const { data: portfolio } = await admin
        .from("investor_portfolios")
        .select("id, investor_id, investment_amount, roi_percentage, roi_mode, duration_months, payout_day, portfolio_code, next_roi_date, created_at")
        .eq("id", portfolioId).maybeSingle();

      if (!portfolio) {
        return json({ error: "Portfolio was created but could not be loaded for funding." }, 500);
      }

      // Wallet debit already posted above at creation time (idempotency key
      // `portfolio-funding-<id>`). Reuse its transaction group id for audit.
      const txGroupId = fundingTxGroupId;

      const { error: approveErr } = await userClient.rpc("approve_pending_portfolio", {
        p_portfolio_id: portfolioId,
      });
      if (approveErr) {
        const msg = approveErr.message || "";
        if (msg.includes("NOT_AUTHORIZED")) {
          return json({ error: "You do not have permission to approve portfolios." }, 403);
        }
        return json({ error: `Wallet was deducted but portfolio activation failed: ${msg}. Please contact operations.` }, 500);
      }

      const maturityDate = addMonthsIsoDate(
        portfolio.created_at,
        Number(portfolio.duration_months) || durationMonths,
      );
      const { error: verifyErr } = await admin
        .from("investor_portfolios")
        .update({
          cfo_verified: true,
          cfo_verified_at: new Date().toISOString(),
          cfo_verified_by: caller.id,
          cfo_rejection_reason: null,
          maturity_date: maturityDate,
        })
        .eq("id", portfolioId);
      if (verifyErr) {
        console.error("[create-portfolio-invite] direct confirmation verification flag failed:", verifyErr);
        return json({ error: "Portfolio activated, but verification flags failed. Please contact operations." }, 500);
      }

      await admin.from("audit_logs").insert({
        user_id: caller.id,
        action_type: "direct_confirmation_portfolio_funded",
        table_name: "investor_portfolios",
        record_id: portfolioId,
        metadata: {
          partner_id: partnerId,
          amount,
          portfolio_code: portfolioCode,
          transaction_group_id: txGroupId,
          reason: "first_time_partner_wallet_funded_active_portfolio",
        },
      });

      await admin.from("system_events").insert({
        event_type: "portfolio_topup",
        user_id: partnerId,
        related_entity_type: "investor_portfolios",
        related_entity_id: portfolioId,
        metadata: {
          amount,
          portfolio_code: portfolioCode,
          transaction_group_id: txGroupId,
          source: "direct_confirmation",
        },
      });

      let emailDispatched = false;
      let emailError: string | null = null;
      if (portfolio && partner.email) {
        const monthlyReward = Math.round(Number(portfolio.investment_amount) * (Number(portfolio.roi_percentage) / 100));
        try {
          await dispatchTransactionalEmail(
            supabaseUrl,
            serviceKey,
            buildPartnershipAgreementRequest({
              recipientEmail: partner.email,
              partnerName: partner.full_name,
              partnerId: portfolio.investor_id,
              portfolioId: portfolio.id,
              amount: Number(portfolio.investment_amount),
              monthlyReward,
              contributionDateIso: portfolio.created_at,
              firstPayoutDateIso: portfolio.next_roi_date || portfolio.created_at,
              payoutDay: portfolio.payout_day || 15,
              roiPercentage: Number(portfolio.roi_percentage),
            }),
          );
          emailDispatched = true;
        } catch (e) {
          emailError = (e as Error)?.message || "unknown";
          console.warn("[create-portfolio-invite] Confirmation email failed:", emailError);
        }
      }

      return json({
        success: true,
        mode: "direct_confirmation",
        portfolio_id: portfolioId,
        portfolio_code: portfolioCode,
        partner_email: partner.email,
        email_dispatched: emailDispatched,
        email_error: emailError,
      }, 200);
    }

    // ── Default invite branch ─────────────────────────────────────────────
    // Send the invite email via existing send-transactional-email pipeline.
    // We reuse the plain 'transactional' template with inline HTML — no new
    // Mailgun template needed for MVP.
    const partnerName = partner.full_name || "Partner";
    let emailDispatched = false;
    let emailError: string | null = null;
    try {
      const { data: emailData, error: emailErr } = await admin.functions.invoke(
        "send-transactional-email",
        {
          body: {
            templateName: "partner-portfolio-invite",
            recipientEmail: partner.email,
            idempotencyKey: `portfolio-invite-${portfolioId}`,
            templateData: {
              partner_name: partnerName,
              portfolio_code: portfolioCode,
              amount,
              duration_months: durationMonths,
              roi_percentage: roiPercentage,
              roi_mode: roiMode,
              completion_url: completionUrl,
              currency: "UGX",
              company_name: "Welile",
            },
          },
        },
      );
      if (emailErr) {
        emailError = emailErr.message || String(emailErr);
        console.error("[create-portfolio-invite] Email dispatch error:", emailError, emailData);
      } else {
        emailDispatched = true;
        console.log("[create-portfolio-invite] Invite email enqueued", { portfolioId, to: partner.email });
      }
    } catch (e) {
      emailError = (e as Error)?.message || "unknown";
      console.error("[create-portfolio-invite] Email dispatch threw:", emailError);
    }

    return json({
      success: true,
      portfolio_id: portfolioId,
      portfolio_code: portfolioCode,
      completion_url: completionUrl,
      partner_email: partner.email,
      email_dispatched: emailDispatched,
      email_error: emailError,
    }, 200);
  } catch (e) {
    console.error("[create-portfolio-invite] Fatal:", (e as Error)?.message, (e as Error)?.stack);
    return json({ error: (e as Error)?.message || "Unexpected server error" }, 500);
  }
});