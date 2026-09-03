import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import {
  buildReturnsProcessingRequest,
  buildPartnerCompoundRequest,
  buildProxyManagedPayoutRequest,
  buildPartnershipTopupRequest,
  resolveManagedProxy,
  dispatchTransactionalEmail,
} from "../_shared/partnership-emails.ts";
import {
  kampalaTodayDateOnly,
  effectiveNextRoiDateOnly,
  isPortfolioRoiDue,
} from "./roiDateGate.ts";
import { evaluateRenewalPayoutGate } from "../_shared/renewalPayoutGate.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PAYOUT_PAUSED = false;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (PAYOUT_PAUSED) {
    console.log('[process-supporter-roi] Payout is currently PAUSED. Skipping all processing.');
    return new Response(
      JSON.stringify({ success: true, paused: true, message: 'Partner auto-payout is currently paused by administrator' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Treasury guard: cron jobs MUST also respect maintenance freeze
    const guardBlock = await checkTreasuryGuard(supabase, "any");
    if (guardBlock) return guardBlock;

    const now = new Date();
    const results = {
      processed: 0,
      credited: 0,
      reinvested: 0,
      skipped: 0,
      totalAmount: 0,
      topupsMerged: 0,
      topupsMergedAmount: 0,
      topupsSkippedNotDue: 0,
      renewalsApplied: 0,
      renewalsDeferred: 0,
      errors: [] as string[],
    };

    // Get all funded rent requests that have a supporter tagged
    const { data: fundedRequests, error: fetchError } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, supporter_id, funded_at, next_roi_due_date, total_roi_paid, roi_payments_count')
      .not('supporter_id', 'is', null)
      .not('funded_at', 'is', null)
      .in('status', ['funded', 'disbursed', 'completed']);

    // Get supporters who have pending/approved withdrawal requests (rewards paused)
    const { data: pausedWithdrawals } = await supabase
      .from('investment_withdrawal_requests')
      .select('user_id')
      .eq('rewards_paused', true)
      .in('status', ['pending', 'approved']);

    const pausedSupporterIds = new Set(
      (pausedWithdrawals || []).map((w: any) => w.user_id)
    );

    // Get auto-reinvest preferences from portfolios
    const { data: reinvestPortfolios } = await supabase
      .from('investor_portfolios')
      .select('investor_id, id, auto_reinvest, investment_amount, created_at, duration_months')
      .eq('auto_reinvest', true)
      .eq('status', 'active');

    const autoReinvestMap = new Map<string, { portfolio_id: string; current_amount: number; contribution_date?: string | null; duration_months?: number | null }>();
    (reinvestPortfolios || []).forEach((p: any) => {
      if (p.investor_id && !autoReinvestMap.has(p.investor_id)) {
        autoReinvestMap.set(p.investor_id, {
          portfolio_id: p.id,
          current_amount: p.investment_amount,
          contribution_date: p.created_at || null,
          duration_months: typeof p.duration_months === 'number' ? p.duration_months : null,
        });
      }
    });

    if (fetchError) {
      throw new Error(`Failed to fetch funded requests: ${fetchError.message}`);
    }

    console.log(`[process-supporter-roi] Found ${fundedRequests?.length || 0} funded requests to check`);

    // NOTE: the matured-portfolio auto-renew sweep used to run HERE, before the
    // payout loop. That ordering skipped the final-cycle ROI (renewal resets
    // next_roi_date/total_roi_earned, so the payout gate then reads "not due").
    // It now runs AFTER the payout leg and is gated on payout completion.

    for (const rr of fundedRequests || []) {
      try {
        if (pausedSupporterIds.has(rr.supporter_id)) {
          console.log(`[process-supporter-roi] Skipping ${rr.supporter_id} — rewards paused`);
          results.skipped++;
          continue;
        }

        const fundedDate = new Date(rr.funded_at);

        // Strict 30-day cycle
        if (rr.next_roi_due_date) {
          const dueDate = new Date(rr.next_roi_due_date);
          if (dueDate > now) { results.skipped++; continue; }
        } else {
          const firstDue = new Date(fundedDate.getTime() + 30 * 24 * 60 * 60 * 1000);
          if (firstDue > now) { results.skipped++; continue; }
        }

        results.processed++;

        const roiAmount = Math.round(Number(rr.rent_amount) * 0.15);
        const paymentNumber = (rr.roi_payments_count || 0) + 1;

        // Check auto-reinvest preference
        const reinvestInfo = autoReinvestMap.get(rr.supporter_id);
        const shouldReinvest = !!reinvestInfo;

        // Insert ROI payment record
        const { error: roiInsertError } = await supabase
          .from('supporter_roi_payments')
          .insert({
            rent_request_id: rr.id,
            supporter_id: rr.supporter_id,
            rent_amount: rr.rent_amount,
            roi_amount: roiAmount,
            payment_number: paymentNumber,
            due_date: now.toISOString(),
            paid_at: now.toISOString(),
            status: shouldReinvest ? 'reinvested' : 'paid',
          });

        if (roiInsertError) {
          if (roiInsertError.code === '23505') {
            console.log(`[process-supporter-roi] Already processed: ${rr.id} payment #${paymentNumber}`);
            continue;
          }
          throw roiInsertError;
        }

        const txGroupId = crypto.randomUUID();

        if (shouldReinvest) {
          // ═══ AUTO-REINVEST: Add ROI to portfolio instead of wallet ═══
          const prevAmount = reinvestInfo.current_amount;
          const newAmount = prevAmount + roiAmount;

          // Update portfolio balance
          await supabase.from('investor_portfolios')
            .update({ investment_amount: newAmount })
            .eq('id', reinvestInfo.portfolio_id);

          // Balanced ledger via RPC: roi_expense → roi_reinvestment
          const { error: reinvestLedgerErr } = await supabase.rpc('create_ledger_transaction', {
            entries: [
              {
              user_id: rr.supporter_id,
              direction: 'cash_out',
              amount: roiAmount,
              category: 'roi_expense',
                ledger_scope: 'platform',
                source_table: 'supporter_roi_payments',
                source_id: rr.id,
                description: `ROI payout #${paymentNumber} auto-reinvested into portfolio`,
                currency: 'UGX',
                linked_party: 'platform',
                transaction_date: now.toISOString(),
              },
              {
                user_id: rr.supporter_id,
                direction: 'cash_in',
                amount: roiAmount,
                category: 'roi_reinvestment',
                ledger_scope: 'platform',
                source_table: 'investor_portfolios',
                source_id: reinvestInfo.portfolio_id,
                description: `Auto-reinvested ROI #${paymentNumber} (${roiAmount.toLocaleString()}) into portfolio`,
                currency: 'UGX',
                linked_party: 'platform',
                transaction_date: now.toISOString(),
              },
            ],
          });

          if (reinvestLedgerErr) throw reinvestLedgerErr;

          // Notify supporter
          await supabase.from('notifications').insert({
            user_id: rr.supporter_id,
            title: '🔄 ROI Auto-Reinvested!',
            message: `Your reward of UGX ${roiAmount.toLocaleString()} (payment #${paymentNumber}) has been automatically added to your portfolio. New balance: UGX ${newAmount.toLocaleString()}.`,
            type: 'earning',
            metadata: { portfolio_id: reinvestInfo.portfolio_id, roi_amount: roiAmount, payment_number: paymentNumber },
          });

          // Update the cached amount for subsequent iterations
          reinvestInfo.current_amount = newAmount;
          results.reinvested++;

          // Partner Compounding Confirmation email — fire-and-forget
          try {
            const { data: partnerProfile } = await supabase
              .from('profiles').select('email, full_name').eq('id', rr.supporter_id).maybeSingle();
            if (partnerProfile?.email) {
              dispatchTransactionalEmail(
                Deno.env.get('SUPABASE_URL')!,
                Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
                buildPartnerCompoundRequest({
                  recipientEmail: partnerProfile.email,
                  partnerName: partnerProfile.full_name,
                  partnerId: rr.supporter_id,
                  portfolioId: reinvestInfo.portfolio_id,
                  paymentNumber,
                  initialAmount: prevAmount,
                  // roiPercentage intentionally omitted — helper derives the
                  // exact rate from returnAmount/initialAmount so partners on
                  // non-15% portfolios see their REAL rate.
                  returnAmount: roiAmount,
                  newTotal: newAmount,
                  compoundDateIso: now.toISOString(),
                  contributionDateIso: reinvestInfo.contribution_date || undefined,
                  durationMonths: reinvestInfo.duration_months || undefined,
                }),
                'process-supporter-roi',
              );
            }
          } catch (emailErr) {
            console.warn('[process-supporter-roi] Compound email lookup failed (non-blocking):', emailErr);
          }
        } else {
          // ═══ STANDARD WALLET CREDIT via RPC ═══
          //
          // We always credit the partner's wallet directly, even if they have
          // an active proxy assignment. The proxy agent will initiate a withdrawal
          // from the partner's wallet later.
          const managedProxy = await resolveManagedProxy(supabase, rr.supporter_id);
          const walletRecipientId = rr.supporter_id;
          const walletDescription = managedProxy
            ? `15% monthly reward (payment #${paymentNumber}) on rent facilitation of UGX ${Number(rr.rent_amount).toLocaleString()} (managed by ${managedProxy.agentName || 'proxy agent'})`
            : `15% monthly reward (payment #${paymentNumber}) on rent facilitation of UGX ${Number(rr.rent_amount).toLocaleString()}`;

          const { error: walletLedgerErr } = await supabase.rpc('create_ledger_transaction', {
            entries: [
              {
              user_id: rr.supporter_id,
              direction: 'cash_out',
              amount: roiAmount,
              category: 'roi_expense',
                ledger_scope: 'platform',
                source_table: 'supporter_roi_payments',
                source_id: rr.id,
                description: `Platform ROI payout #${paymentNumber} to supporter for rent facilitation of UGX ${Number(rr.rent_amount).toLocaleString()}`,
                currency: 'UGX',
                linked_party: 'platform',
                transaction_date: now.toISOString(),
              },
              {
                user_id: walletRecipientId,
                direction: 'cash_in',
                amount: roiAmount,
                category: 'roi_wallet_credit',
                ledger_scope: 'wallet',
                recipient_type: 'user',
                wallet_bucket: 'withdrawable',
                source_table: 'supporter_roi_payments',
                source_id: rr.id,
                description: walletDescription,
                currency: 'UGX',
                linked_party: 'platform',
                transaction_date: now.toISOString(),
              },
            ],
          });

          if (walletLedgerErr) throw walletLedgerErr;

          // Customer advance recovery: deduct the configured % of this ROI
          // toward any active advance set to recover from ROI.
          try {
            await supabase.rpc('apply_roi_advance_recovery', {
              p_user_id: walletRecipientId,
              p_roi_amount: roiAmount,
              p_source_id: rr.id,
              p_idempotency_key: `sup-roi-${rr.id}-${paymentNumber}`,
            });
          } catch (recErr) {
            console.error('[process-supporter-roi] ROI advance recovery failed:', recErr);
          }

          if (managedProxy) {
            // Partner notification — money went to their wallet, agent will deliver.
            await supabase.from('notifications').insert({
              user_id: rr.supporter_id,
              title: '⏳ Monthly Return Approved — Processing',
              message: `Your monthly return of UGX ${roiAmount.toLocaleString()} (payment #${paymentNumber}) has been approved and is being processed. Your proxy agent ${managedProxy.agentName || 'agent'} will complete the payout. You'll get a final confirmation once the funds are delivered.`,
              type: 'earning',
              metadata: {
                rent_request_id: rr.id,
                roi_amount: roiAmount,
                payment_number: paymentNumber,
                routed_to_proxy_agent_id: managedProxy.agentId,
                proxy_assignment_id: managedProxy.assignmentId,
              },
            });
            // Proxy agent notification — explain they need to initiate withdrawal.
            await supabase.from('notifications').insert({
              user_id: managedProxy.agentId,
              title: '🤝 Proxy Payout Ready for Delivery',
              message: `UGX ${roiAmount.toLocaleString()} (reward #${paymentNumber}) was credited to your partner's wallet. Please initiate a withdrawal from the Proxy Partners tab.`,
              type: 'earning',
              metadata: {
                rent_request_id: rr.id,
                roi_amount: roiAmount,
                payment_number: paymentNumber,
                on_behalf_of_partner_id: rr.supporter_id,
                proxy_assignment_id: managedProxy.assignmentId,
              },
            });
          } else {
            await supabase.from('notifications').insert({
              user_id: rr.supporter_id,
              title: '⏳ Monthly Return Approved — Processing',
              message: `Your monthly return of UGX ${roiAmount.toLocaleString()} (payment #${paymentNumber}) has been approved and is being processed. You'll receive a final confirmation as soon as the payout is delivered.`,
              type: 'earning',
              metadata: { rent_request_id: rr.id, roi_amount: roiAmount, payment_number: paymentNumber },
            });
          }

          // Stage 1 email: "Processing" — sent on approval only.
          // The Stage 2 "Paid" email (returns-disbursement-confirmation) is
          // dispatched later by approve-withdrawal once funds actually leave.
          try {
            const { data: partnerProfile } = await supabase
              .from('profiles').select('email, full_name').eq('id', rr.supporter_id).maybeSingle();
            if (partnerProfile?.email) {
              dispatchTransactionalEmail(
                Deno.env.get('SUPABASE_URL')!,
                Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
                buildReturnsProcessingRequest({
                  recipientEmail: partnerProfile.email,
                  partnerName: partnerProfile.full_name,
                  partnerId: rr.supporter_id,
                  txGroupId: `${rr.id}-${paymentNumber}`,
                  amount: roiAmount,
                  transactionId: `ROI-${rr.id.slice(0, 8).toUpperCase()}-${paymentNumber}`,
                  payoutMethod: 'Wallet',
                  isManagedByAgent: !!managedProxy,
                  agentName: managedProxy?.agentName || undefined,
                }),
                'process-supporter-roi',
              );
            }

            // Proxy-agent notice — fire-and-forget
            if (managedProxy?.agentEmail) {
              const { data: partnerProfile2 } = await supabase
                .from('profiles').select('full_name').eq('id', rr.supporter_id).maybeSingle();
              dispatchTransactionalEmail(
                Deno.env.get('SUPABASE_URL')!,
                Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
                buildProxyManagedPayoutRequest({
                  recipientEmail: managedProxy.agentEmail,
                  agentName: managedProxy.agentName,
                  agentId: managedProxy.agentId,
                  partnerName: partnerProfile2?.full_name,
                  partnerId: rr.supporter_id,
                  amount: roiAmount,
                  transactionId: `ROI-${rr.id.slice(0, 8).toUpperCase()}-${paymentNumber}`,
                  txGroupId: `${rr.id}-${paymentNumber}`,
                  payoutKind: 'Monthly Returns',
                  reason: 'Partner wallet credited. Please initiate delivery withdrawal.',
                }),
                'process-supporter-roi',
              );
            }
          } catch (emailErr) {
            console.warn('[process-supporter-roi] Returns email lookup failed (non-blocking):', emailErr);
          }

          results.credited++;
        }

        // Update rent request ROI tracking
        const nextDueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        await supabase.from('rent_requests').update({
          next_roi_due_date: nextDueDate.toISOString(),
          total_roi_paid: (rr.total_roi_paid || 0) + roiAmount,
          roi_payments_count: paymentNumber,
        }).eq('id', rr.id);

        results.totalAmount += roiAmount;
        // Log system event
        logSystemEvent(supabase, 'roi_distributed', rr.supporter_id, 'supporter_roi_payments', rr.id, { amount: roiAmount, payment_number: paymentNumber, reinvested: shouldReinvest });

        console.log(`[process-supporter-roi] ${shouldReinvest ? 'Reinvested' : 'Paid'} ${roiAmount} for supporter ${rr.supporter_id} (payment #${paymentNumber})`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[process-supporter-roi] Error on ${rr.id}:`, msg);
        results.errors.push(`${rr.id}: ${msg}`);
      }
    }

    // ═══ POST-PAYOUT: Merge pending top-ups into portfolio principal ═══
    // IMPORTANT: this MUST run for EVERY active portfolio that has an open top-up
    // (status `pending`, `awaiting_verification`, or `approved`) — NOT only for
    // partners who happened to have a funded rent request this cycle. Previously the
    // merge iterated over supporters derived from `fundedRequests`, so partners whose
    // capital was not yet deployed to a funded tenant never got their top-ups merged.
    //
    // NO FINOPS REQUIRED: a parked top-up auto-merges into principal the moment its
    // portfolio's Returns payout is processed (ROI date due). It does NOT need to be
    // approved by Financial Ops first — the payout event itself is the trigger. So we
    // include `awaiting_verification` (the state the 6PM cron parks them in) alongside
    // `pending`/`approved` in the merge filter below.
    //
    // MERGE-AFTER-PAYOUT (2026-06-12): the top-up merge no longer happens here.
    // A parked top-up must only activate AFTER its portfolio's Returns payout has
    // actually been approved by Financial Ops — not merely when the ROI date is due.
    // That logic now lives in the DB routine `public.merge_paidout_topups()` which
    // runs on the `merge-paidout-topups-7pm` cron (16:00 UTC = 7:00 PM EAT). Keeping
    // the inline merge here would prematurely merge top-ups at the due date before the
    // payout is approved, so it is disabled.
    const INLINE_TOPUP_MERGE_ENABLED = false;
    const portfolioIdsToMerge: string[] = INLINE_TOPUP_MERGE_ENABLED
      ? [...new Set(
          ((await supabase
            .from('pending_wallet_operations')
            .select('source_id')
            .eq('source_table', 'investor_portfolios')
            .eq('operation_type', 'portfolio_topup')
            .in('status', ['approved', 'pending', 'awaiting_verification'])).data || [])
            .map((op: any) => op.source_id).filter(Boolean),
        )]
      : [];

    for (const portfolioId of portfolioIdsToMerge) {
      try {
        // Resolve the portfolio — must be active to receive merged capital
        const { data: portfolio } = await supabase
          .from('investor_portfolios')
          .select('id, investment_amount, portfolio_code, account_name, investor_id, agent_id, status, roi_percentage, next_roi_date, created_at, payout_day')
          .eq('id', portfolioId)
          .maybeSingle();

        if (!portfolio || portfolio.status !== 'active') continue;

        // ─── DATE GATE ───────────────────────────────────────────────────────
        // Only merge parked top-ups for portfolios whose ROI date is actually due
        // (effective next_roi_date <= today, Africa/Kampala). Future-dated
        // portfolios keep their top-ups "parked" until their real cycle arrives.
        // Without this gate the cron merged every portfolio with an open top-up,
        // regardless of date (the bug that prematurely activated 15 portfolios).
        if (!isPortfolioRoiDue(portfolio as any)) {
          results.topupsSkippedNotDue++;
          console.log(
            `[process-supporter-roi] Skip top-up merge for ${portfolio.portfolio_code || portfolio.id}: ` +
            `ROI date ${effectiveNextRoiDateOnly((portfolio as any).next_roi_date, (portfolio as any).created_at, (portfolio as any).payout_day)} ` +
            `not due yet (today ${kampalaTodayDateOnly()}).`,
          );
          continue;
        }

        const supporterId = portfolio.investor_id || portfolio.agent_id;
        // Respect reward pause: skip partners with paused rewards
        if (supporterId && pausedSupporterIds.has(supporterId)) continue;

        {
          // Check for pending top-ups on this portfolio
          const { data: pendingOps } = await supabase
            .from('pending_wallet_operations')
            .select('id, amount, transaction_group_id, metadata, status')
            .eq('source_id', portfolio.id)
            .eq('source_table', 'investor_portfolios')
            .eq('operation_type', 'portfolio_topup')
            .in('status', ['approved', 'pending', 'awaiting_verification']);

          if (!pendingOps || pendingOps.length === 0) continue;

          const totalPending = pendingOps.reduce((s, op) => s + Number(op.amount), 0);
          const currentAmount = Number(portfolio.investment_amount);
          const newAmount = currentAmount + totalPending;
          const accountLabel = portfolio.account_name || portfolio.portfolio_code;
          const partnerId = portfolio.investor_id || portfolio.agent_id;
          const mergeGroupId = crypto.randomUUID();

          // 1. Update portfolio principal
          const { error: updateErr } = await supabase
            .from('investor_portfolios')
            .update({ investment_amount: newAmount })
            .eq('id', portfolio.id);

          if (updateErr) {
            console.error(`[process-supporter-roi] Failed to merge top-ups for portfolio ${portfolio.id}:`, updateErr.message);
            continue;
          }

          // 2. Mark pending ops as completed (auto-applied at the ROI cycle).
          //    reviewed_by is a UUID column, so we CANNOT store a sentinel string
          //    there (the old 'system:roi-merge' value silently failed every merge
          //    and rolled it back). We leave reviewed_by NULL and flag the automatic
          //    nature in each op's metadata (preserving any existing keys) so the
          //    COO dashboard can surface an "auto-applied" badge.
          const pendingIds = pendingOps.map(op => op.id);
          const completeResults = await Promise.all(
            pendingOps.map((op: any) =>
              supabase
                .from('pending_wallet_operations')
                .update({
                  status: 'completed',
                  reviewed_at: now.toISOString(),
                  reviewed_by: null,
                  metadata: {
                    ...(op.metadata && typeof op.metadata === 'object' ? op.metadata : {}),
                    auto_applied_at_roi_cycle: true,
                    merged_at: now.toISOString(),
                  },
                })
                .eq('id', op.id)
            )
          );
          const approveErr = completeResults.find((r: any) => r.error)?.error;

          if (approveErr) {
            // Rollback — restore principal and revert any ops already flipped
            await supabase
              .from('investor_portfolios')
              .update({ investment_amount: currentAmount })
              .eq('id', portfolio.id);
            await Promise.all(
              completeResults.map((r: any, i: number) =>
                r.error
                  ? null
                  : supabase
                      .from('pending_wallet_operations')
                      .update({ status: pendingOps[i].status, reviewed_at: null, reviewed_by: null })
                      .eq('id', pendingOps[i].id)
              )
            );
            console.error(`[process-supporter-roi] Rollback merge for portfolio ${portfolio.id}:`, approveErr.message);
            continue;
          }

          // 3. Ledger entry: pending capital now activates into portfolio (platform scope)
          await supabase.rpc('create_ledger_transaction', {
            entries: [
              {
                user_id: partnerId,
                amount: totalPending,
                direction: 'cash_out',
                category: 'pending_portfolio_topup',
                source_table: 'investor_portfolios',
                source_id: portfolio.id,
                description: `Auto-merged ${pendingOps.length} pending top-up(s) into ${accountLabel} at ROI cycle`,
                currency: 'UGX',
                ledger_scope: 'platform',
                transaction_date: now.toISOString(),
              },
              {
                user_id: partnerId,
                amount: totalPending,
                direction: 'cash_in',
                category: 'partner_funding',
                source_table: 'investor_portfolios',
                source_id: portfolio.id,
                description: `${pendingOps.length} pending top-up(s) merged into ${accountLabel} — capital activated`,
                currency: 'UGX',
                ledger_scope: 'platform',
                transaction_date: now.toISOString(),
              },
            ],
          });

          // 4. Audit log
          await supabase.from('audit_logs').insert({
            user_id: null,
            action_type: 'auto_merge_pending_topups',
            table_name: 'investor_portfolios',
            record_id: portfolio.id,
            metadata: {
              partner_id: partnerId,
              count: pendingOps.length,
              total_merged: totalPending,
              previous_capital: currentAmount,
              new_capital: newAmount,
              pending_op_ids: pendingIds,
              trigger: 'roi_cycle',
            },
          });

          // 5. Notify partner
          await supabase.from('notifications').insert({
            user_id: partnerId,
            title: '🔄 Top-Ups Merged Into Capital',
            message: `${pendingOps.length} pending deposit(s) totaling UGX ${totalPending.toLocaleString()} have been added to "${accountLabel}". New capital: UGX ${newAmount.toLocaleString()}.`,
            type: 'success',
            metadata: { portfolio_id: portfolio.id, total_merged: totalPending, new_capital: newAmount },
          });

          // 5b. Partnership Top-Up email — same template used by the manual approval flow.
          //     Sent to the partner whose capital just activated automatically at the ROI cycle.
          if (partnerId) {
            try {
              const { data: partnerProfile } = await supabase
                .from('profiles')
                .select('email, full_name')
                .eq('id', partnerId)
                .maybeSingle();
              if (partnerProfile?.email) {
                // `currentAmount` is the portfolio's real capital before the
                // merge (including compounded returns), and `newAmount` is what
                // the portfolio now shows. Using contributed principal here made
                // the emailed new total lower than the actual portfolio value.
                const previousValue = Number(currentAmount) || 0;
                dispatchTransactionalEmail(
                  supabaseUrl,
                  supabaseServiceKey,
                  buildPartnershipTopupRequest({
                    recipientEmail: partnerProfile.email,
                    partnerName: partnerProfile.full_name,
                    partnerId,
                    txGroupId: mergeGroupId, // unique per auto-merge batch
                    topupAmount: totalPending,
                    previousPortfolioValue: previousValue,
                    newTotalPartnershipValue: Number(newAmount) || previousValue + totalPending,
                    roiPercentage: Number((portfolio as any).roi_percentage) || undefined,
                    portfolioId: portfolio.id,
                    portfolioName: accountLabel,
                    reviewedBy: "System",
                    portfoliosToppedUpCount: 1,
                    effectiveAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                  }),
                  "process-supporter-roi",
                );
              }
            } catch (emailErr) {
              console.warn('[process-supporter-roi] Top-up email lookup failed (non-blocking):', emailErr);
            }
          }

          // Update reinvest map if applicable
          if (autoReinvestMap.has(supporterId) && autoReinvestMap.get(supporterId)!.portfolio_id === portfolio.id) {
            autoReinvestMap.get(supporterId)!.current_amount = newAmount;
          }

          results.topupsMerged += pendingOps.length;
          results.topupsMergedAmount += totalPending;
          console.log(`[process-supporter-roi] Merged ${pendingOps.length} pending top-ups (${totalPending}) into portfolio ${portfolio.id} for supporter ${supporterId}`);

          logSystemEvent(supabase, 'pending_topups_merged', supporterId, 'investor_portfolios', portfolio.id, {
            count: pendingOps.length,
            total: totalPending,
            new_capital: newAmount,
          });
        }
      } catch (mergeErr: unknown) {
        const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        console.error(`[process-supporter-roi] Merge error for portfolio ${portfolioId}:`, msg);
        results.errors.push(`merge:${portfolioId}: ${msg}`);
      }
    }

    console.log(`[process-supporter-roi] Done: ${results.credited} wallet-credited, ${results.reinvested} auto-reinvested, ${results.topupsMerged} top-ups merged (${results.topupsMergedAmount}), ${results.topupsSkippedNotDue} portfolios skipped (ROI date not due), total ROI: ${results.totalAmount}`);

    // ═══ AUTO-RENEW MATURED PORTFOLIOS — AFTER THE PAYOUT LEG ═══
    // Renewal is the LAST step and only fires when the portfolio's due ROI
    // cycle is already settled (ledger row with the cycle idempotency key) or
    // nothing is due. Anything still awaiting payout/approval defers to the
    // next run, so no partner loses a final-cycle payout to a renewal reset.
    try {
      const todayStr = kampalaTodayDateOnly();
      const { data: expired } = await supabase
        .from('investor_portfolios')
        .select('id, investor_id, portfolio_code, maturity_date, next_roi_date, created_at, payout_day')
        .eq('status', 'active')
        .not('maturity_date', 'is', null)
        .lte('maturity_date', todayStr)
        .is('pending_renewal_effective_date', null)
        .limit(500);
      const systemActor =
        (await supabase.from('user_roles').select('user_id').eq('role', 'cfo').limit(1).maybeSingle()).data?.user_id
        || (await supabase.from('user_roles').select('user_id').eq('role', 'manager').limit(1).maybeSingle()).data?.user_id;
      for (const p of expired || []) {
        try {
          if (!systemActor) break;
          const gate = await evaluateRenewalPayoutGate(supabase, {
            id: p.id,
            next_roi_date: (p as any).next_roi_date ?? null,
            created_at: (p as any).created_at,
            payout_day: (p as any).payout_day ?? null,
          });
          if (!gate.allowed) {
            results.renewalsDeferred++;
            console.log(`[process-supporter-roi] Renewal deferred for ${p.portfolio_code} — ${gate.reason} (cycle ${gate.cycleDate})`);
            continue;
          }
          await supabase.rpc('apply_portfolio_renewal', {
            p_portfolio_id: p.id,
            p_renewed_by: systemActor,
            p_reason: `Auto-renewed after payout leg — matured portfolio (${gate.reason})`,
          });
          results.renewalsApplied++;
          console.log(`[process-supporter-roi] Auto-renewed matured portfolio ${p.portfolio_code} after payout (${gate.reason})`);
        } catch (e) {
          console.warn(`[process-supporter-roi] Auto-renew failed for ${p.portfolio_code}:`, e);
        }
      }
    } catch (e) {
      console.warn('[process-supporter-roi] Post-payout renewal sweep failed (non-blocking):', e);
    }

    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "💼 ROI Processed", body: "Activity: supporter ROI processed", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(
      JSON.stringify({
        success: true,
        message: `Processed ${results.processed}: ${results.credited} wallet, ${results.reinvested} reinvested, ${results.skipped} skipped, ${results.topupsMerged} top-ups merged`,
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[process-supporter-roi] Fatal:', msg);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
