import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipTopupRequest, dispatchTransactionalEmail } from "../_shared/partnership-emails.ts";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { topupHoldEntries, topupHoldKey, topupReleaseEntries, topupReleaseKey } from "../_shared/topupFloatHold.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * approve-portfolio-topup
 * 
 * Financial Ops action: Verifies awaiting_verification top-ups.
 * On approval, creates a pending_portfolio_topup ledger entry to park the funds.
 * The process-supporter-roi engine merges parked funds into principal at next ROI cycle.
 * Only callable by financial_ops / cfo / super_admin / manager / coo roles.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Treasury guard: approving top-ups parks/credits funds — block when paused
    const guardBlock = await checkTreasuryGuard(supabase, "credit", req.headers.get("Authorization"));
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

    // Only Financial Ops / CFO / super_admin / manager / coo can approve
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const allowedRoles = ["operations", "cfo", "super_admin", "manager", "coo"];
    const hasRole = (roles || []).some((r: any) => allowedRoles.includes(r.role));
    if (!hasRole) {
      return new Response(JSON.stringify({ error: "Only Financial Operations can approve portfolio top-ups" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { portfolio_id, action } = body;
    const rejectReason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!portfolio_id || !UUID_RE.test(portfolio_id)) {
      return new Response(JSON.stringify({ error: "Invalid portfolio_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!action || !["approve", "reject"].includes(action)) {
      return new Response(JSON.stringify({ error: "action must be 'approve' or 'reject'" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rejections MUST carry a human-readable reason — it is shown to the partner
    // in their portfolio and pre-filled into their support chat message.
    if (action === "reject" && rejectReason.length < 5) {
      return new Response(JSON.stringify({ error: "A rejection reason of at least 5 characters is required." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch portfolio
    const { data: portfolio, error: pErr } = await supabase
      .from("investor_portfolios")
      .select("id, investor_id, agent_id, investment_amount, portfolio_code, account_name, status, roi_percentage")
      .eq("id", portfolio_id)
      .single();

    if (pErr || !portfolio) {
      return new Response(JSON.stringify({ error: "Portfolio not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all awaiting_verification top-ups for this portfolio
    const { data: awaitingOps, error: fetchErr } = await supabase
      .from("pending_wallet_operations")
      .select("id, amount, user_id, transaction_group_id, metadata")
      .eq("source_id", portfolio_id)
      .eq("source_table", "investor_portfolios")
      .eq("operation_type", "portfolio_topup")
      .eq("status", "awaiting_verification");

    if (fetchErr) {
      return new Response(JSON.stringify({ error: "Failed to fetch top-ups" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!awaitingOps || awaitingOps.length === 0) {
      return new Response(JSON.stringify({ error: "No top-ups awaiting verification for this portfolio" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalAmount = awaitingOps.reduce((s, op) => s + Number(op.amount), 0);
    const currentInvestment = Number(portfolio.investment_amount);
    const accountLabel = portfolio.account_name || portfolio.portfolio_code;
    const now = new Date().toISOString();
    const opIds = awaitingOps.map(op => op.id);
    const partnerId = portfolio.investor_id || portfolio.agent_id;

    // ── REJECT ──
    if (action === "reject") {
      // Held top-ups (portfolio-topup took the amount out of operational
      // float at request time) are released back to the same float, one op at
      // a time with an idempotent key, then marked rejected. Older requests
      // that were never held only need marking. Existing metadata is kept.
      let rejectErr: { message: string } | null = null;
      for (const op of awaitingOps) {
        const meta = (op.metadata && typeof op.metadata === "object") ? op.metadata as Record<string, unknown> : {};
        const wasHeld = meta.float_hold === "held";
        if (wasHeld) {
          const walletUserId = (typeof meta.source_wallet_user_id === "string" && meta.source_wallet_user_id)
            ? meta.source_wallet_user_id as string
            : (op.user_id || partnerId);
          const { error: relErr } = await supabase.rpc("create_ledger_transaction", {
            idempotency_key: topupReleaseKey(op.id),
            entries: topupReleaseEntries({
              walletUserId,
              partnerId: partnerId || walletUserId,
              amount: Number(op.amount),
              portfolioId: portfolio_id,
              portfolioCode: portfolio.portfolio_code,
              label: accountLabel,
              note: rejectReason,
            }),
          });
          if (relErr) { rejectErr = relErr; break; }
          await supabase.rpc("repair_wallet_cache_for_user", { p_user_id: walletUserId });
        }
        const { error: upErr } = await supabase
          .from("pending_wallet_operations")
          .update({
            status: "rejected",
            reviewed_at: now,
            reviewed_by: user.id,
            metadata: {
              ...meta,
              ...(wasHeld ? { float_hold: "released", released_at: now } : {}),
              rejection_reason: rejectReason, rejected_by: user.id, rejected_at: now,
              funds_returned_to_wallet: true,
            },
          })
          .eq("id", op.id);
        if (upErr) { rejectErr = upErr; break; }
      }

      if (rejectErr) {
        console.error("[approve-portfolio-topup] reject failed:", rejectErr);
        return new Response(JSON.stringify({ error: "Failed to reject top-ups" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("audit_logs").insert({
        user_id: user.id,
        action_type: "reject_portfolio_topup",
        table_name: "pending_wallet_operations",
        record_id: portfolio_id,
        metadata: { portfolio_code: portfolio.portfolio_code, count: awaitingOps.length, total_amount: totalAmount, op_ids: opIds, rejection_reason: rejectReason },
      });

      if (partnerId) {
        await logSystemEvent(supabase, "portfolio_topup_rejected", partnerId, "investor_portfolios", portfolio_id, {
          count: awaitingOps.length,
          total_amount: totalAmount,
          portfolio_code: portfolio.portfolio_code,
          rejected_by: user.id,
          rejection_reason: rejectReason,
        });
      }

      // Notify the partner (fire-and-forget) that their transfer was declined
      // and the funds remain in their wallet.
      if (partnerId) {
        fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
          body: JSON.stringify({
            userIds: [partnerId],
            payload: {
              title: "❌ Portfolio Top-Up Declined",
              body: `Your UGX ${totalAmount.toLocaleString()} transfer to ${accountLabel} was declined: ${rejectReason}. Any amount held for it has been returned to your operational float.`,
              url: "/dashboard/funder",
              type: "warning",
            },
          }),
        }).catch(() => {});
      }

      return new Response(JSON.stringify({
        success: true, action: "rejected", count: awaitingOps.length, total_amount: totalAmount, reason: rejectReason,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── APPROVE: Park funds with ledger entry until next ROI cycle ──

    // Split ops by funding source:
    //   heldOps     — portfolio-topup already took the amount out of operational
    //                 float at request time (metadata.float_hold = 'held').
    //                 Nothing to move here; approval only parks them.
    //   unheldOps   — older requests (before hold-at-request) that never moved
    //                 money (metadata.requires_wallet_debit). Debit operational
    //                 float NOW, with the same legs as a request-time hold.
    //   externalOps — off-platform deposits, simply parked (money already arrived).
    // A request whose hold never completed (float_hold 'pending'/'failed')
    // must not be approved: no money is behind it.
    const metaOf = (op: any) => (op?.metadata && typeof op.metadata === "object") ? op.metadata : {};
    const brokenHold = (awaitingOps || []).filter(
      (op: any) => metaOf(op).float_hold && metaOf(op).float_hold !== "held",
    );
    if (brokenHold.length > 0) {
      return new Response(JSON.stringify({
        error: `${brokenHold.length} top-up request(s) on this portfolio have no completed float hold. Reject them; the partner can resubmit.`,
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const heldOps = (awaitingOps || []).filter((op: any) => metaOf(op).float_hold === "held");
    const unheldOps = (awaitingOps || []).filter(
      (op: any) => !metaOf(op).float_hold && metaOf(op).requires_wallet_debit === true,
    );
    const externalOps = (awaitingOps || []).filter(
      (op: any) => !metaOf(op).float_hold && metaOf(op).requires_wallet_debit !== true,
    );
    const heldTotal = heldOps.reduce((s: number, op: any) => s + Number(op.amount), 0);
    const unheldTotal = unheldOps.reduce((s: number, op: any) => s + Number(op.amount), 0);
    const externalTotal = externalOps.reduce((s: number, op: any) => s + Number(op.amount), 0);

    // 0. Older unheld requests: re-validate OPERATIONAL FLOAT (never
    //    withdrawable) and take it now, one op at a time.
    if (unheldTotal > 0) {
      const walletUserId = unheldOps[0]?.user_id || partnerId;
      if (!walletUserId) {
        return new Response(JSON.stringify({ error: "Cannot resolve wallet owner for this transfer request" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: availRaw, error: availErr } = await supabase.rpc(
        "funder_float_available",
        { p_user_id: walletUserId },
      );
      if (availErr) {
        console.error("[approve-portfolio-topup] float balance lookup failed:", availErr);
        return new Response(JSON.stringify({ error: "Could not verify partner operational float. Please retry." }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const avail = Number(availRaw ?? 0);
      if (avail < unheldTotal) {
        return new Response(JSON.stringify({
          error: `Partner operational float no longer covers this transfer. Needs UGX ${unheldTotal.toLocaleString()}, but only UGX ${avail.toLocaleString()} is available. Ask the partner to add float or reject the request.`,
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      for (const op of unheldOps) {
        const opUserId = op.user_id || walletUserId;
        const { data: holdGroupId, error: debitErr } = await supabase.rpc("create_ledger_transaction", {
          idempotency_key: topupHoldKey(op.id),
          entries: topupHoldEntries({
            walletUserId: opUserId,
            partnerId: partnerId || opUserId,
            amount: Number(op.amount),
            portfolioId: portfolio_id,
            portfolioCode: portfolio.portfolio_code,
            label: accountLabel,
          }),
        });
        if (debitErr) {
          console.error("[approve-portfolio-topup] Float debit failed:", debitErr);
          return new Response(JSON.stringify({ error: "Failed to take the top-up from partner operational float. Nothing was approved." }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        await supabase
          .from("pending_wallet_operations")
          .update({
            metadata: {
              ...metaOf(op),
              fund_source: "float",
              source_wallet_user_id: opUserId,
              source_wallet_owner: "Operational Float",
              float_hold: "held",
              hold_group_id: holdGroupId,
              held_at: now,
              held_at_approval: true,
            },
          })
          .eq("id", op.id);
      }

      const { error: repairErr } = await supabase.rpc("repair_wallet_cache_for_user", {
        p_user_id: walletUserId,
      });
      if (repairErr) {
        console.warn("[approve-portfolio-topup] wallet cache repair failed (safe — cron will reconcile):", repairErr);
      }
    }
    console.log(`[approve-portfolio-topup] ${portfolio.portfolio_code}: held=${heldTotal} unheld_debited_now=${unheldTotal} external=${externalTotal}`);

    // 1. Mark all ops as approved (parked)
    const { error: approveErr } = await supabase
      .from("pending_wallet_operations")
      .update({ status: "approved", reviewed_at: now, reviewed_by: user.id })
      .in("id", opIds);

    if (approveErr) {
      return new Response(JSON.stringify({ error: "Failed to approve top-ups" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Create ledger entry for parked capital (pending_portfolio_topup) for
    //    EXTERNAL / off-platform deposits only. Wallet-funded transfers were
    //    already moved above via partner_funding legs, matching the legacy flow.
    //    The process-supporter-roi engine will later reverse this with a cash_out
    //    and create a partner_funding cash_in when merging into active capital.
    if (partnerId && externalTotal > 0) {
      try {
        const { error: ledgerErr } = await supabase.rpc("create_ledger_transaction", {
          entries: [
            {
              user_id: partnerId,
              amount: externalTotal,
              direction: "cash_in",
              category: "pending_portfolio_topup",
              source_table: "investor_portfolios",
              source_id: portfolio_id,
              description: `Verified deposit of UGX ${externalTotal.toLocaleString()} for "${accountLabel}" (${portfolio.portfolio_code}). Parked until next ROI cycle.`,
              currency: "UGX",
              ledger_scope: "platform",
              transaction_date: now,
            },
            {
              user_id: partnerId,
              amount: externalTotal,
              direction: "cash_out",
              category: "pending_portfolio_topup",
              source_table: "investor_portfolios",
              source_id: portfolio_id,
              description: `Platform contra for verified portfolio deposit — ${portfolio.portfolio_code}`,
              currency: "UGX",
              ledger_scope: "platform",
              transaction_date: now,
            },
          ],
        });

        if (ledgerErr) {
          console.error("[approve-portfolio-topup] Ledger entry failed:", ledgerErr);
          // Non-blocking — the approval is already recorded in pending_wallet_operations
        } else {
          console.log(`[approve-portfolio-topup] Ledger entry created for ${externalTotal} parked in ${portfolio.portfolio_code}`);
        }
      } catch (ledgerEx) {
        console.error("[approve-portfolio-topup] Ledger exception:", ledgerEx);
      }
    }

    // 3. Audit log
    await supabase.from("audit_logs").insert({
      user_id: user.id,
      action_type: "approve_portfolio_topup",
      table_name: "investor_portfolios",
      record_id: portfolio_id,
      metadata: {
        partner_id: partnerId,
        count: awaitingOps.length,
        total_parked: totalAmount,
        current_capital: currentInvestment,
        op_ids: opIds,
        note: "Funds parked — will merge into principal at next ROI payout cycle",
      },
    });

    // 4. Log system event (replaces suppressed notifications)
    if (partnerId) {
      await logSystemEvent(supabase, "portfolio_topup_approved", partnerId, "investor_portfolios", portfolio_id, {
        count: awaitingOps.length,
        total_parked: totalAmount,
        current_capital: currentInvestment,
        portfolio_code: portfolio.portfolio_code,
        account_name: accountLabel,
        approved_by: user.id,
      });
    }

    // 5. Notify executives via system events
    try {
      const { data: execs } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["cfo", "coo"]);
      if (execs && execs.length > 0) {
        const uniqueIds = [...new Set(execs.map((e: any) => e.user_id).filter((id: string) => id !== user.id))];
        for (const uid of uniqueIds) {
          await logSystemEvent(supabase, "portfolio_topup_verified", uid, "investor_portfolios", portfolio_id, {
            count: awaitingOps.length,
            total_parked: totalAmount,
            current_capital: currentInvestment,
            portfolio_code: portfolio.portfolio_code,
            approved_by: user.id,
          });
        }
      }
    } catch (_e) {
      // non-blocking
    }

    // Partnership Top-Up email — target = partner (not the FinOps actor)
    if (partnerId) {
      try {
        const [{ data: partnerEmailRow }, { data: reviewerProfile }] = await Promise.all([
          supabase.from("profiles").select("email, full_name").eq("id", partnerId).maybeSingle(),
          supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
        ]);
        if (partnerEmailRow?.email) {
          // Use the portfolio's ACTUAL capital (which includes any compounded
          // returns) as the "previous value" so the email total matches the
          // figure the partner sees on their portfolio. Contributed principal
          // excludes compounding and made the emailed new total too low.
          const previousValue = Number(currentInvestment) || 0;
          dispatchTransactionalEmail(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            buildPartnershipTopupRequest({
              recipientEmail: partnerEmailRow.email,
              partnerName: partnerEmailRow.full_name,
              partnerId,
              txGroupId: portfolio_id,  // approval batch keyed by portfolio
              topupAmount: totalAmount,
              previousPortfolioValue: previousValue,
              newTotalPartnershipValue: previousValue + totalAmount,
              roiPercentage: Number((portfolio as any).roi_percentage) || undefined,
              portfolioId: portfolio.id,
              portfolioName: accountLabel,
              reviewedBy: reviewerProfile?.full_name || user.id,
              portfoliosToppedUpCount: 1,
              effectiveAt: now,
              createdAt: now,
            }),
            "approve-portfolio-topup",
          );
        }
      } catch (emailErr) {
        console.warn("[approve-portfolio-topup] Email lookup failed (non-blocking):", emailErr);
      }
    }

    console.log(`[approve-portfolio-topup] FinOps ${user.id} verified ${awaitingOps.length} top-ups (${totalAmount}) for ${portfolio_id}. Ledger entry created. Capital unchanged at ${currentInvestment} — funds parked until next ROI cycle.`);

    return new Response(JSON.stringify({
      success: true,
      action: "approved",
      count: awaitingOps.length,
      total_parked: totalAmount,
      current_capital: currentInvestment,
      portfolio_code: portfolio.portfolio_code,
      note: "Funds verified & parked. Will merge into active capital at next ROI payout.",
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[approve-portfolio-topup] Error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
