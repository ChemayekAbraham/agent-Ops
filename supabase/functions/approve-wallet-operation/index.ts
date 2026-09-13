import { createClient } from "npm:@supabase/supabase-js@2";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { resolveManagedProxy } from "../_shared/partnership-emails.ts";
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from '../_shared/cfoApprovalGate.ts';

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
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: claimsData, error: claimsError } = await userClient.auth.getUser();
    if (claimsError || !claimsData?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.user.id as string;

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Treasury guard: wallet operations move money — block when paused
    const guardBlock = await checkTreasuryGuard(adminClient, "any", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    // Verify authorized role
    const allowedRoles = ['manager', 'coo', 'cfo', 'cto', 'super_admin'];
    const { data: userRoles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", allowedRoles);

    if (!userRoles || userRoles.length === 0) {
      return new Response(
        JSON.stringify({ error: "You do not have permission to approve wallet operations" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Anyone approving in a CFO capacity must be the designated CFO approver.
    // Financial Ops keeps its own verification duty (separation of powers).
    const { data: finOpsRole } = await adminClient
      .from("user_roles").select("role").eq("user_id", userId).eq("role", "financial_ops").maybeSingle();
    if (!finOpsRole && !(await isCfoApprover(adminClient, userId))) {
      return cfoApproverDenied(corsHeaders);
    }

    const body = await req.json();
    const { operation_id, action, rejection_reason, bulk_ids, display_currency, payment_method, payment_reference, override_amount } = body as {
      operation_id?: string;
      action: "approve" | "reject";
      rejection_reason?: string;
      bulk_ids?: string[];
      display_currency?: string;
      payment_method?: string;
      payment_reference?: string;
      override_amount?: number;
    };

    // Validate action
    if (action !== "approve" && action !== "reject") {
      return new Response(
        JSON.stringify({ error: "Invalid action. Must be 'approve' or 'reject'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate rejection_reason length
    if (rejection_reason && typeof rejection_reason === "string" && rejection_reason.length > 1000) {
      return new Response(
        JSON.stringify({ error: "Rejection reason must be under 1000 characters" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate bulk_ids size limit
    if (bulk_ids && Array.isArray(bulk_ids) && bulk_ids.length > 100) {
      return new Response(
        JSON.stringify({ error: "Cannot process more than 100 operations at once" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const idsToProcess = bulk_ids || (operation_id ? [operation_id] : []);

    if (idsToProcess.length === 0) {
      return new Response(
        JSON.stringify({ error: "No operation IDs provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "reject" && !rejection_reason) {
      return new Response(
        JSON.stringify({ error: "Rejection reason required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch pending operations (accept both 'pending' and 'coo_approved' statuses)
    const { data: operations, error: fetchErr } = await adminClient
      .from("pending_wallet_operations")
      .select("*")
      .in("id", idsToProcess)
      .in("status", ["pending", "coo_approved"]);

    if (fetchErr || !operations || operations.length === 0) {
      return new Response(
        JSON.stringify({ error: "No pending operations found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: Array<{ id: string; status: string; user_id: string; amount: number }> = [];
    const failedResults: Array<{ id: string; error: string }> = [];

    for (const op of operations) {
      if (action === "approve") {
        // Ensure transaction_group_id is always set so sync_wallet_from_ledger trigger fires
        const effectiveTxGroupId = op.transaction_group_id || crypto.randomUUID();

        // ── CFO ROI override ──────────────────────────────────────────────
        // The CFO may edit the ROI payout amount on the "pay out to user
        // wallet" page before disbursing. Only applies to a SINGLE ROI payout
        // operation (never bulk) to keep batch approvals predictable. Once set,
        // every downstream ledger leg, wallet credit and notification reads the
        // overridden `op.amount`, and the persisted row is updated to match.
        const isSingleRoiOverride =
          idsToProcess.length === 1 &&
          override_amount !== undefined &&
          override_amount !== null &&
          (op.category === 'roi_payout' || op.category === 'supporter_platform_rewards');
        if (isSingleRoiOverride) {
          const newAmt = Number(override_amount);
          if (!Number.isFinite(newAmt) || newAmt <= 0) {
            return new Response(
              JSON.stringify({ error: "Override amount must be a positive number" }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          op.amount = Math.round(newAmt);
        }

        const isRoiWalletPayout = op.category === 'roi_payout' || op.category === 'supporter_platform_rewards';

        // ── Manager/CTO Direct Balance Adjustment bucket routing ────────────
        // AddBalanceDialog (reached from /platform-users → user card → Adjust
        // Balance) lets the operator explicitly choose which wallet bucket the
        // credit/debit lands in and stamps that choice onto `account`
        // ('withdrawable' or 'float'). Without this, manager_credit/debit fell
        // through to the implicit agent-role heuristic in
        // wallet_route_for_category, so the operator had no visibility into —
        // or control over — which bucket actually moved. Mirrors the
        // recipient_type mechanism cfo-direct-credit already uses (Wallet
        // Routing v2). Default to 'withdrawable' for older queued ops that
        // predate the bucket picker.
        const isManagerAdjustment = op.category === 'manager_credit' || op.category === 'manager_debit';
        const managerBucket: 'withdrawable' | 'float' = op.account === 'float' ? 'float' : 'withdrawable';
        const managerRecipientType: 'user' | 'operational_wallet' = managerBucket === 'float' ? 'operational_wallet' : 'user';
        // Managed-proxy ROI rule: if the partner has an active approved managed
        // proxy assignment, the FULL ROI wallet leg belongs on the proxy agent's
        // wallet and is earmarked with linked_party=partner. The partner wallet
        // must not receive any of that ROI; FinOps later debits the same agent
        // wallet/partner earmark when approving the withdrawal.
        const managedProxy = isRoiWalletPayout ? await resolveManagedProxy(adminClient, op.user_id) : null;
        const ledgerUserId = managedProxy?.agentId || op.user_id;
        const isManaged = !!managedProxy;
        const walletLinkedParty = isRoiWalletPayout ? op.user_id : op.linked_party;
        const displayDescription = isRoiWalletPayout && op.description
          ? String(op.description)
              .replace(/\[Partner Wallet via Proxy\]/gi, '[Proxy Agent Wallet]')
              .replace(/\[Partner Wallet\]/gi, isManaged ? '[Proxy Agent Wallet]' : '[Partner Wallet]')
              .replace(/'s partner wallet/gi, isManaged ? "'s proxy agent wallet" : "'s partner wallet")
              .replace(/to partner wallet/gi, isManaged ? 'to proxy agent wallet' : 'to partner wallet')
          : op.description;
        if (isManaged) {
          console.log(`[approve-wallet-op] Managed proxy ROI: crediting proxy agent ${ledgerUserId} for partner ${op.user_id} on op ${op.id}`);
        }

        // ── ROI CYCLE IDEMPOTENCY GUARD ───────────────────────────────────
        // A portfolio may only receive its ROI ONCE per payout cycle. The cycle
        // is identified by the portfolio's current `next_roi_date` (which only
        // advances after an ROI approval), so two accidental double-submissions
        // — or a repeated execution — resolve to the SAME idempotency key and
        // the second one is refused instead of crediting the wallet twice.
        let roiCycleKey: string | null = null;
        if (isRoiWalletPayout && op.source_table === 'investor_portfolios' && op.source_id) {
          const { data: cyclePf } = await adminClient
            .from('investor_portfolios')
            .select('next_roi_date')
            .eq('id', op.source_id)
            .maybeSingle();
          const cycleAnchor = (op.metadata?.cycle_anchor as string | null)
            || (cyclePf?.next_roi_date as string | null)
            || new Date().toISOString().slice(0, 10);
          const correctionKey = typeof op.metadata?.correction_key === 'string'
            ? op.metadata.correction_key.trim()
            : '';
          roiCycleKey = correctionKey
            ? `roi-cycle-correction-${correctionKey}`
            : `roi-cycle-${op.source_id}-${cycleAnchor}`;

          const { data: alreadyCredited } = await adminClient
            .from('general_ledger')
            .select('id')
            .eq('idempotency_key', roiCycleKey)
            .limit(1);

          if (alreadyCredited && alreadyCredited.length > 0) {
            console.warn(`[approve-wallet-op] DUPLICATE ROI blocked for portfolio ${op.source_id} cycle ${cycleAnchor} (op ${op.id})`);
            await adminClient
              .from('pending_wallet_operations')
              .update({
                status: 'rejected',
                metadata: {
                  ...(op.metadata || {}),
                  duplicate_roi_blocked: true,
                  duplicate_cycle: cycleAnchor,
                  duplicate_idempotency_key: roiCycleKey,
                  rejected_reason: 'Portfolio already received its ROI for this payout cycle',
                  rejected_at: new Date().toISOString(),
                },
              })
              .eq('id', op.id);
            failedResults.push({
              id: op.id,
              error: `Duplicate ROI payout blocked — this portfolio was already credited for its ${cycleAnchor} cycle.`,
            });
            continue;
          }
        }

        // Insert into general_ledger (this triggers wallet balance update via existing trigger)
        // Determine ledger_scope for the USER-FACING entry (entry[0])
        // Categories that credit/debit a user's wallet MUST use 'wallet' scope
        // so the sync_wallet_from_ledger trigger fires and updates wallet balance.
        const WALLET_CREDIT_CATEGORIES = [
          'roi_payout', 'supporter_platform_rewards', 'agent_commission_payout',
          'agent_requisition', 'salary_payment', 'employee_advance',
          'platform_expense_disbursement',
        ];
        const PLATFORM_ONLY_CATEGORIES = [
          'tenant_access_fee', 'tenant_request_fee', 'platform_service_income',
          'landlord_platform_fee', 'management_fee',
          'transaction_platform_expenses', 'operational_expenses',
        ];
        const BRIDGE_CATEGORIES = ['supporter_facilitation_capital', 'wallet_to_investment'];
        const scopeForCategory = WALLET_CREDIT_CATEGORIES.includes(op.category)
          ? 'wallet'
          : BRIDGE_CATEGORIES.includes(op.category)
            ? 'bridge'
            : PLATFORM_ONLY_CATEGORIES.includes(op.category)
              ? 'platform'
              : 'wallet';

        // BUCKET DEFAULTING: For wallet-credit categories where the operator did
        // NOT explicitly choose a bucket, default to 'withdrawable'. This prevents
        // a class of "approved-but-vanished" payouts caused by ledger rows being
        // inserted with account=NULL — the wallet writer cannot route a credit
        // without a bucket and silently drops it.
        const resolvedAccount: string | null = op.account
          || (WALLET_CREDIT_CATEGORIES.includes(op.category) ? 'withdrawable' : null);

        // Snapshot the recipient wallet BEFORE the ledger insert so we can
        // verify the credit actually landed in a bucket after the trigger fires.
        let walletBefore: { withdrawable_balance: number; float_balance: number; advance_balance: number; balance: number } | null = null;
        if (scopeForCategory === 'wallet') {
          const { data: walletSnap } = await adminClient
            .from('wallets')
            .select('withdrawable_balance, float_balance, advance_balance, balance')
            .eq('user_id', ledgerUserId)
            .maybeSingle();
          walletBefore = walletSnap as any;
        }

        // Insert into general_ledger via RPC
        const ledgerPostStart = Date.now();
        const { data: rpcTxGroupId, error: ledgerErr } = await adminClient.rpc('create_ledger_transaction', {
          entries: [
            {
              user_id: ledgerUserId,
              amount: op.amount,
              direction: op.direction,
              category: op.category === 'supporter_platform_rewards' ? 'roi_wallet_credit'
                : op.category === 'roi_payout' ? 'roi_wallet_credit'
                : op.category === 'agent_commission_payout' ? 'agent_commission_earned'
                : op.category === 'platform_expense_disbursement' ? 'system_balance_correction'
                : op.category === 'salary_payment' ? 'system_balance_correction'
                : op.category === 'employee_advance' ? 'system_balance_correction'
                : op.category === 'agent_requisition' ? 'system_balance_correction'
                : op.category === 'supporter_facilitation_capital' ? 'partner_funding'
                : op.category === 'wallet_to_investment' ? 'partner_funding'
                : op.category === 'rent_payment_for_tenant' ? 'agent_float_used_for_rent'
                : op.category,
              ledger_scope: scopeForCategory,
              description: isManaged
                ? `[Managed Payout] ${displayDescription || ''} — on behalf of partner ${op.user_id}`
                : displayDescription,
              source_table: op.source_table,
              source_id: op.source_id,
              linked_party: walletLinkedParty,
              reference_id: op.reference_id,
              account: resolvedAccount,
              recipient_type: isRoiWalletPayout ? 'user' : (isManagerAdjustment ? managerRecipientType : undefined),
              wallet_bucket: isRoiWalletPayout ? 'withdrawable' : (isManagerAdjustment ? managerBucket : undefined),
              routing_source: isRoiWalletPayout ? 'recipient_type_v2' : (isManagerAdjustment ? 'manager_adjustment_bucket_v1' : undefined),
              currency: 'UGX',
              transaction_date: new Date().toISOString(),
            },
            {
              direction: op.direction === 'cash_in' ? 'cash_out' : 'cash_in',
              amount: op.amount,
              category: op.category === 'supporter_platform_rewards' ? 'roi_expense'
                : op.category === 'roi_payout' ? 'roi_expense'
                : op.category === 'supporter_facilitation_capital' ? 'partner_funding'
                : 'system_balance_correction',
              ledger_scope: 'platform',
              description: `Platform contra for ${op.category}`,
              source_table: op.source_table,
              source_id: op.source_id,
              currency: 'UGX',
              transaction_date: new Date().toISOString(),
            },
          ],
          idempotency_key: roiCycleKey ?? undefined,
        });

        if (ledgerErr) {
          console.error(`[approve-wallet-op] Ledger insert failed for ${op.id}:`, ledgerErr);
          failedResults.push({ id: op.id, error: ledgerErr.message || 'Ledger insert failed' });
          continue;
        }

        // RACE-SAFE ROI IDEMPOTENCY: create_ledger_transaction returns the
        // pre-existing group (posting NOTHING) when the cycle key was already
        // used. If that row predates this invocation, a concurrent/earlier
        // approval already credited this cycle — bail out BEFORE the wallet
        // delta-recovery below, which would otherwise re-credit the wallet.
        if (roiCycleKey) {
          const { data: keyRows } = await adminClient
            .from('general_ledger')
            .select('created_at')
            .eq('idempotency_key', roiCycleKey)
            .order('created_at', { ascending: true })
            .limit(1);
          const firstAt = keyRows?.[0]?.created_at ? new Date(keyRows[0].created_at).getTime() : null;
          if (firstAt !== null && firstAt < ledgerPostStart - 1500) {
            console.warn(`[approve-wallet-op] DUPLICATE ROI blocked (idempotent hit) for op ${op.id} key ${roiCycleKey}`);
            await adminClient
              .from('pending_wallet_operations')
              .update({
                status: 'rejected',
                metadata: {
                  ...(op.metadata || {}),
                  duplicate_roi_blocked: true,
                  duplicate_idempotency_key: roiCycleKey,
                  rejected_reason: 'Portfolio already received its ROI for this payout cycle (concurrent)',
                  rejected_at: new Date().toISOString(),
                },
              })
              .eq('id', op.id);
            failedResults.push({
              id: op.id,
              error: 'Duplicate ROI payout blocked — this portfolio was already credited for this payout cycle.',
            });
            continue;
          }
        }

        // HARD-FAIL SAFETY: For wallet-scope credits, verify the bucket actually
        // moved. If it didn't, the credit landed in the ledger but never reached
        // the wallet — exactly the bug that lost LUKODDA JOSEPH's 1.5M ROI payout.
        // We mark the operation as failed so the operator sees it instead of a
        // false "success" toast.
        if (scopeForCategory === 'wallet' && walletBefore && op.direction === 'cash_in') {
          const { data: walletAfter } = await adminClient
            .from('wallets')
            .select('withdrawable_balance, float_balance, advance_balance, balance')
            .eq('user_id', ledgerUserId)
            .maybeSingle();
          const beforeTotal = (walletBefore.withdrawable_balance || 0) + (walletBefore.float_balance || 0) + (walletBefore.advance_balance || 0);
          const afterTotal = (walletAfter?.withdrawable_balance || 0) + (walletAfter?.float_balance || 0) + (walletAfter?.advance_balance || 0);
          const delta = afterTotal - beforeTotal;
          // Allow a small tolerance for concurrent operations on busy wallets.
          if (delta < op.amount - 1) {
            console.error(`[approve-wallet-op] WALLET ROUTING FAILURE for op ${op.id}: ledger credited ${op.amount} but wallet only moved by ${delta}. Forcing recovery via apply_wallet_movement.`);
            // Recover via the sole authorized writer
            const { error: recoveryErr } = await adminClient.rpc('apply_wallet_movement', {
              p_user_id: ledgerUserId,
              p_category: op.category === 'supporter_platform_rewards' || op.category === 'roi_payout' ? 'roi_wallet_credit'
                : op.category === 'agent_commission_payout' ? 'agent_commission_earned'
                : op.category,
              p_amount: op.amount - delta,
              p_direction: 'cash_in',
            });
            if (recoveryErr) {
              failedResults.push({ id: op.id, error: `Wallet routing failed and recovery also failed: ${recoveryErr.message}` });
              continue;
            }
          }
        }

        // ── Advance next_roi_date on ROI payout approval ──
        // ── CUSTOMER ADVANCE RECOVERY FROM ROI ──
        // If the recipient has an active advance configured to recover from ROI,
        // deduct only the configured percentage of this ROI payout and apply it
        // to the outstanding balance (balanced double-entry, idempotent).
        if (isRoiWalletPayout && op.direction === 'cash_in') {
          try {
            const { data: recovery, error: recoveryErr } = await adminClient.rpc('apply_roi_advance_recovery', {
              p_user_id: ledgerUserId,
              p_roi_amount: op.amount,
              p_source_id: op.source_id || null,
              p_idempotency_key: roiCycleKey || `op-${op.id}`,
            });
            if (recoveryErr) {
              console.error(`[approve-wallet-op] ROI advance recovery failed for op ${op.id}:`, recoveryErr);
            } else if ((recovery as any)?.recovered > 0) {
              console.log(`[approve-wallet-op] Recovered ${(recovery as any).recovered} from ROI for ${ledgerUserId}`);
            }
          } catch (recErr) {
            console.error(`[approve-wallet-op] ROI advance recovery threw for op ${op.id}:`, recErr);
          }
        }

        if ((op.category === 'roi_payout' || op.category === 'supporter_platform_rewards') && op.source_table === 'investor_portfolios' && op.source_id) {
          try {
            // Get current next_roi_date to advance from it (not from today)
            const { data: portfolio } = await adminClient
              .from('investor_portfolios')
              .select('next_roi_date, created_at, payout_day')
              .eq('id', op.source_id)
              .single();

            if (portfolio) {
              const currentDate = portfolio.next_roi_date
                ? new Date(portfolio.next_roi_date + 'T00:00:00')
                : new Date(portfolio.created_at);
              const nextDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, currentDate.getDate());
              const nextDateStr = nextDate.toISOString().split('T')[0];

              await adminClient
                .from('investor_portfolios')
                .update({ next_roi_date: nextDateStr })
                .eq('id', op.source_id);

              console.log(`[approve-wallet-op] Advanced next_roi_date for portfolio ${op.source_id} to ${nextDateStr}`);
            }
          } catch (dateErr) {
            console.error(`[approve-wallet-op] Failed to advance next_roi_date for portfolio ${op.source_id}:`, dateErr);
          }
        }

        // If this is an agent rent payment for a tenant, update receivables
        if (op.category === 'rent_payment_for_tenant' && op.direction === 'cash_in' && op.user_id) {
          // The cash_in direction means tenant wallet was credited — update their rent repayment.
          // Try the Treasury waterfall first; fall back to legacy repayment so a missing
          // funding-side L7 credit never blocks the tenant's payment.
          try {
            const { error: waterfallErr } = await adminClient.rpc("record_rent_request_repayment_v2", {
              p_tenant_id: op.user_id,
              p_amount: op.amount,
              p_source_table: 'pending_wallet_operations',
              p_source_id: op.id,
            });
            if (waterfallErr) throw waterfallErr;
            console.log(`[approve-wallet-op] Treasury waterfall recorded for tenant ${op.user_id}, amount: ${op.amount}`);
          } catch (rpcErr: any) {
            console.error(`[approve-wallet-op] Treasury waterfall failed for ${op.id}, falling back to legacy repayment:`, rpcErr?.message || rpcErr);
            try {
              await adminClient.rpc("record_rent_request_repayment", {
                p_tenant_id: op.user_id,
                p_amount: op.amount,
              });
              console.log(`[approve-wallet-op] Updated receivables for tenant ${op.user_id}, amount: ${op.amount}`);
            } catch (fallbackErr: any) {
              console.error(`[approve-wallet-op] Failed to update receivables for ${op.id}:`, fallbackErr?.message || fallbackErr);
            }
          }
        }

        // ── Advance recovery is handled exclusively by the scheduled cron ──
        // `sweep_agent_advance_recovery` (every 15 min). The previous inline
        // wallet-balance-based sweep on deposit was removed so there is a single
        // source of truth and no double-recovery / race with the cron.

        // ── Auto-deduct rent repayment from remaining balance ──
        // When a user deposits money and has an active rent request, auto-deduct outstanding rent
        if (op.direction === 'cash_in' && op.user_id && op.category !== 'rent_payment_for_tenant' && op.category !== 'supporter_facilitation_capital') {
          try {
            const { data: activeRentRequest } = await adminClient
              .from("rent_requests")
              .select("id, total_repayment, amount_repaid, status")
              .eq("tenant_id", op.user_id)
              .in("status", ["funded", "disbursed", "approved"])
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (activeRentRequest) {
              const outstanding = Number(activeRentRequest.total_repayment) - Number(activeRentRequest.amount_repaid);

              if (outstanding > 0) {
                const { data: freshWallet } = await adminClient
                  .from("wallets")
                  .select("balance")
                  .eq("user_id", op.user_id)
                  .single();

                const availableBalance = freshWallet?.balance || 0;

                if (availableBalance > 0) {
                  const repaymentAmount = Math.min(availableBalance, outstanding);

                  // Try the Treasury waterfall first; fall back to legacy repayment so a
                  // missing funding-side L7 credit never blocks the tenant's payment.
                  let waterfallOk = false;
                  try {
                    const { error: waterfallErr } = await adminClient.rpc(
                      "record_rent_request_repayment_v2",
                      { p_tenant_id: op.user_id, p_amount: repaymentAmount, p_source_table: 'pending_wallet_operations', p_source_id: op.id }
                    );
                    if (waterfallErr) throw waterfallErr;
                    waterfallOk = true;
                    console.log(`[approve-wallet-op] Treasury waterfall recorded for tenant ${op.user_id}, amount: ${repaymentAmount}`);
                  } catch (waterfallErr: any) {
                    console.error(`[approve-wallet-op] Treasury waterfall failed for ${op.id}, falling back to legacy repayment:`, waterfallErr?.message || waterfallErr);
                  }

                  let repaymentErr = null;
                  if (!waterfallOk) {
                    const { error: legacyErr } = await adminClient.rpc(
                      "record_rent_request_repayment",
                      { p_tenant_id: op.user_id, p_amount: repaymentAmount }
                    );
                    repaymentErr = legacyErr;
                  }

                  if (!repaymentErr) {
                    const { error: rentLedgerErr } = await adminClient.rpc('create_ledger_transaction', {
                      entries: [
                        {
                          user_id: op.user_id,
                          amount: repaymentAmount,
                          direction: 'cash_out',
                          category: 'tenant_repayment',
                          ledger_scope: 'wallet',
                          source_table: 'pending_wallet_operations',
                          source_id: op.id,
                          reference_id: op.reference_id || op.id,
                          description: `Auto rent deduction from wallet deposit (Ref: ${op.reference_id || 'N/A'})`,
                          currency: 'UGX',
                          linked_party: activeRentRequest.id,
                          transaction_date: new Date().toISOString(),
                        },
                        {
                          direction: 'cash_in',
                          amount: repaymentAmount,
                          category: 'tenant_repayment',
                          ledger_scope: 'platform',
                          source_table: 'pending_wallet_operations',
                          source_id: op.id,
                          description: `Platform receives rent repayment`,
                          currency: 'UGX',
                          transaction_date: new Date().toISOString(),
                        },
                      ],
                    });
                    if (rentLedgerErr) {
                      console.error(`[approve-wallet-op] Rent ledger RPC failed:`, rentLedgerErr.message);
                    }

                    const newOutstanding = outstanding - repaymentAmount;
                    console.log(`[approve-wallet-op] Auto-deducted UGX ${repaymentAmount} for rent repayment. Remaining: ${newOutstanding}. Tenant: ${op.user_id}`);

                    await adminClient.from("notifications").insert({
                      user_id: op.user_id,
                      title: "Rent Auto-Deducted 🏠",
                      message: `UGX ${repaymentAmount.toLocaleString()} auto-deducted for rent repayment from your deposit. Outstanding: UGX ${newOutstanding.toLocaleString()}.`,
                      type: "info",
                    });
                  } else {
                    console.error(`[approve-wallet-op] Rent repayment RPC failed for ${op.user_id}:`, repaymentErr.message);
                  }
                }
              }
            }
          } catch (rentErr) {
            console.error(`[approve-wallet-op] Auto-deduction error for ${op.id}:`, rentErr);
          }
        }

        // If this is a supporter_facilitation_capital approval, activate the linked portfolio
        let portfolioInvestorId: string | null = null;
        if (op.category === 'supporter_facilitation_capital' && op.source_table === 'investor_portfolios' && op.source_id) {
          // Fetch the portfolio to get the actual investor_id (funder)
          const { data: portfolioData } = await adminClient
            .from("investor_portfolios")
            .select("investor_id, agent_id, portfolio_code")
            .eq("id", op.source_id)
            .single();

          portfolioInvestorId = portfolioData?.investor_id || null;

          const updatePayload: Record<string, any> = { status: "active" };
          if (display_currency) {
            updatePayload.display_currency = display_currency;
          }

          const { error: portfolioActivateErr } = await adminClient
            .from("investor_portfolios")
            .update(updatePayload)
            .eq("id", op.source_id)
            .eq("status", "pending_approval");
          if (portfolioActivateErr) {
            console.error(`[approve-wallet-op] Failed to activate portfolio ${op.source_id}:`, portfolioActivateErr);
          } else {
            console.log(`[approve-wallet-op] Activated portfolio ${op.source_id} for investor ${portfolioInvestorId}`);

            // ── 2% Investment Commission for the facilitating agent ──
            if (portfolioData?.agent_id) {
              const commissionAmount = Math.round(op.amount * 0.02);
              if (commissionAmount > 0) {
                // Record in agent_earnings
                const { error: commErr } = await adminClient
                  .from("agent_earnings")
                  .insert({
                    agent_id: portfolioData.agent_id,
                    amount: commissionAmount,
                    earning_type: "investment_commission",
                    description: `2% investment commission on UGX ${op.amount.toLocaleString()} activation (${portfolioData.portfolio_code || ''})`,
                    source_user_id: portfolioInvestorId,
                    rent_request_id: null,
                  });
                if (commErr) {
                  console.error(`[approve-wallet-op] Failed to record investment commission:`, commErr);
                } else {
                  // Credit agent wallet via balanced RPC
                  const { error: commLedgerErr } = await adminClient.rpc('create_ledger_transaction', {
                    entries: [
                      {
                        direction: 'cash_out',
                        amount: commissionAmount,
                        category: 'agent_commission_earned',
                        ledger_scope: 'platform',
                        description: `Platform pays 2% commission on investment activation ${portfolioData.portfolio_code || ''}`,
                        currency: 'UGX',
                        source_table: 'agent_earnings',
                        source_id: op.source_id,
                        transaction_date: new Date().toISOString(),
                      },
                      {
                        user_id: portfolioData.agent_id,
                        amount: commissionAmount,
                        direction: 'cash_in',
                        category: 'agent_commission_earned',
                        ledger_scope: 'wallet',
                        description: `2% commission on investment activation ${portfolioData.portfolio_code || ''}`,
                        currency: 'UGX',
                        source_table: 'agent_earnings',
                        source_id: op.source_id,
                        linked_party: portfolioInvestorId || 'Partner',
                        reference_id: op.reference_id,
                        transaction_date: new Date().toISOString(),
                      },
                    ],
                  });
                  if (commLedgerErr) console.error(`[approve-wallet-op] Commission ledger RPC failed:`, commLedgerErr);
                  else console.log(`[approve-wallet-op] Credited agent ${portfolioData.agent_id} with ${commissionAmount} investment commission`);
                }
              }
            }
          }

          // Determine the correct user for ledger entries (the funder, not the agent)
          const funderId = portfolioInvestorId || op.user_id;

          // Immediately debit wallet → investment (net zero wallet impact)
          const investTxGroupId = crypto.randomUUID();
          const { error: investDebitErr } = await adminClient.rpc('create_ledger_transaction', {
            entries: [
              {
                user_id: funderId,
                amount: op.amount,
                direction: 'cash_out',
                category: 'partner_funding',
                ledger_scope: 'wallet',
                description: `Capital invested into portfolio ${portfolioData?.portfolio_code || ''}. Ref: ${op.reference_id}`,
                source_table: 'investor_portfolios',
                source_id: op.source_id,
                linked_party: 'Rent Management Pool',
                reference_id: op.reference_id,
                currency: 'UGX',
                transaction_date: new Date().toISOString(),
              },
              {
                direction: 'cash_in',
                amount: op.amount,
                category: 'partner_funding',
                ledger_scope: 'platform',
                description: `Platform receives investment capital`,
                source_table: 'investor_portfolios',
                source_id: op.source_id,
                currency: 'UGX',
                transaction_date: new Date().toISOString(),
              },
            ],
          });
          if (investDebitErr) {
            console.error(`[approve-wallet-op] Failed to debit wallet for investment ${op.id}:`, investDebitErr);
          } else {
            console.log(`[approve-wallet-op] Debited wallet → investment for funder ${funderId}, amount: ${op.amount}`);
          }
        }

        // ── Portfolio Top-Up Approval: deduct wallet + increase principal ──
        if (op.operation_type === 'portfolio_topup' && op.source_table === 'investor_portfolios' && op.source_id) {
          try {
            const partnerId = op.user_id;

            // Re-verify wallet balance (fresh check to prevent race conditions)
            const { data: freshWallet } = await adminClient
              .from("wallets")
              .select("balance")
              .eq("user_id", partnerId)
              .single();

            const walletBalance = Number(freshWallet?.balance || 0);
            if (walletBalance < op.amount) {
              failedResults.push({ id: op.id, error: `Insufficient wallet balance. Available: UGX ${walletBalance.toLocaleString()}, Required: UGX ${op.amount.toLocaleString()}` });
              continue;
            }

            // Balanced ledger entries: wallet cash_out + platform cash_in
            const { error: topupLedgerErr } = await adminClient.rpc('create_ledger_transaction', {
              entries: [
                {
                  user_id: partnerId,
                  amount: op.amount,
                  direction: "cash_out",
                  category: "partner_funding",
                  source_table: "investor_portfolios",
                  source_id: op.source_id,
                  description: `Wallet deduction for portfolio top-up — approved by Financial Ops`,
                  currency: 'UGX',
                  ledger_scope: "wallet",
                  transaction_date: new Date().toISOString(),
                },
                {
                  user_id: partnerId,
                  amount: op.amount,
                  direction: "cash_in",
                  category: "partner_funding",
                  source_table: "investor_portfolios",
                  source_id: op.source_id,
                  description: `Capital received for portfolio top-up — Financial Ops verified`,
                  currency: 'UGX',
                  ledger_scope: "platform",
                  transaction_date: new Date().toISOString(),
                },
              ],
            });

            if (topupLedgerErr) {
              console.error(`[approve-wallet-op] Portfolio top-up ledger failed for ${op.id}:`, topupLedgerErr);
              failedResults.push({ id: op.id, error: topupLedgerErr.message || 'Portfolio top-up ledger failed' });
              continue;
            }

            // Update portfolio investment_amount
            const { data: portfolio } = await adminClient
              .from("investor_portfolios")
              .select("investment_amount, portfolio_code, account_name")
              .eq("id", op.source_id)
              .single();

            if (portfolio) {
              const newAmount = Number(portfolio.investment_amount) + op.amount;
              await adminClient
                .from("investor_portfolios")
                .update({ investment_amount: newAmount })
                .eq("id", op.source_id);

              console.log(`[approve-wallet-op] Portfolio ${op.source_id} capital updated: ${portfolio.investment_amount} → ${newAmount}`);

              // Notify partner
              const accountLabel = portfolio.account_name || portfolio.portfolio_code;
              await adminClient.from("notifications").insert({
                user_id: partnerId,
                title: "✅ Portfolio Top-Up Approved",
                message: `UGX ${op.amount.toLocaleString()} top-up for "${accountLabel}" has been approved by Financial Operations. New capital: UGX ${newAmount.toLocaleString()}.`,
                type: "success",
                metadata: { portfolio_id: op.source_id, amount: op.amount, new_capital: newAmount },
              });

              // Audit log
              await adminClient.from("audit_logs").insert({
                user_id: userId,
                action_type: "approve_portfolio_topup",
                table_name: "investor_portfolios",
                record_id: op.source_id,
                metadata: {
                  partner_id: partnerId,
                  amount: op.amount,
                  previous_capital: Number(portfolio.investment_amount),
                  new_capital: newAmount,
                  pending_op_id: op.id,
                  wallet_balance_before: walletBalance,
                },
              });
            }
          } catch (topupErr) {
            console.error(`[approve-wallet-op] Portfolio top-up processing error for ${op.id}:`, topupErr);
            failedResults.push({ id: op.id, error: 'Portfolio top-up processing failed' });
            continue;
          }
        }

        // Mark as approved with payment details
        await adminClient
          .from("pending_wallet_operations")
          .update({
            status: "approved",
            reviewed_by: userId,
            reviewed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            payment_method: payment_method || null,
            payment_reference: payment_reference || null,
            amount: op.amount,
          })
          .eq("id", op.id);

        // ── Send Partner Wallet Deposit email to PARTNER on ROI payouts ──
        // Suppressed for managed-proxy payouts because the ROI was credited to
        // the proxy agent wallet and the partner receives disbursement notice at withdrawal.
        if (op.category === 'roi_payout' || op.category === 'supporter_platform_rewards') {
          try {
            const { data: partnerProfile } = await adminClient
              .from("profiles")
              .select("email, full_name")
              .eq("id", op.user_id)
              .maybeSingle();

            if (partnerProfile?.email) {
              // Suppress this email for proxy partners — they receive the
              // "Returns Disbursement Confirmation" email at withdrawal time
              // instead. Sending both is redundant and confusing.
              const { data: proxyAssignment } = await adminClient
                .from("proxy_agent_assignments")
                .select("id")
                .eq("beneficiary_id", op.user_id)
                .eq("beneficiary_role", "supporter")
                .eq("is_active", true)
                .eq("approval_status", "approved")
                .maybeSingle();
              if (proxyAssignment) {
                console.log(`[approve-wallet-op] Skipping partner-wallet-deposit email — partner ${op.user_id} is a proxy partner (assignment=${proxyAssignment.id}); disbursement email handles this on withdrawal.`);
              } else {
              const { data: partnerWallet } = await adminClient
                .from("wallets")
                .select("id")
                .eq("user_id", op.user_id)
                .maybeSingle();
              const walletLast4 = partnerWallet?.id
                ? partnerWallet.id.replace(/-/g, '').slice(-4)
                : '';

              const refId = op.reference_id || payment_reference || op.id;
              const todayLabel = new Date().toLocaleDateString('en-GB', {
                day: '2-digit', month: 'long', year: 'numeric',
              });

              await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({
                  templateName: "partner-wallet-deposit",
                  recipientEmail: partnerProfile.email,
                  idempotencyKey: `partner-wallet-deposit-${op.id}`,
                  templateData: {
                    partner_name: partnerProfile.full_name || "Partner",
                    transaction_id: refId,
                    amount: op.amount,
                    currency: "UGX",
                    date: todayLabel,
                    wallet_id_last4: walletLast4,
                    source: "Platform",
                    company_name: "Welile",
                    logo_url: "https://welileapp.com/welile-logo.png",
                  },
                }),
              });
              console.log(`[approve-wallet-op] Partner wallet deposit email queued for partner ${op.user_id}`);
              }
            }
          } catch (emailErr) {
            console.warn(`[approve-wallet-op] Partner wallet deposit email enqueue failed for ${op.id}:`, emailErr);
          }
        }

        // Notify the correct user(s)
        if (op.category === 'supporter_facilitation_capital' && portfolioInvestorId) {
          // Notify the FUNDER (investor)
          await adminClient.from("notifications").insert({
            user_id: portfolioInvestorId,
            title: "Investment Activated ✅",
            message: `Your UGX ${op.amount.toLocaleString()} investment has been approved and is now active. Monthly rewards will begin within 30 days.`,
            type: "success",
            metadata: { operation_id: op.id, amount: op.amount, direction: op.direction },
          });

          // Also notify the AGENT who facilitated it
          if (op.user_id !== portfolioInvestorId) {
            await adminClient.from("notifications").insert({
              user_id: op.user_id,
              title: "Partner Investment Approved ✅",
              message: `UGX ${op.amount.toLocaleString()} investment you facilitated has been approved and activated.`,
              type: "success",
              metadata: { operation_id: op.id, amount: op.amount },
            });
          }
        } else if (isManaged) {
          // Managed payout: notify both agent and partner
          await adminClient.from("notifications").insert({
            user_id: ledgerUserId,
            title: "Proxy ROI Received ✅",
            message: `UGX ${op.amount.toLocaleString()} credited to your wallet as ROI for ${op.metadata?.partner_name || 'your proxy partner'}. Ref: ${op.reference_id || 'N/A'}`,
            type: "success",
            metadata: { operation_id: op.id, amount: op.amount, on_behalf_of: op.user_id },
          });
          await adminClient.from("notifications").insert({
            user_id: op.user_id,
            title: "ROI Sent to Proxy Agent ✅",
            message: `Your ROI payout of UGX ${op.amount.toLocaleString()} has been sent to your assigned proxy agent for collection.`,
            type: "success",
            metadata: { operation_id: op.id, amount: op.amount, agent_id: ledgerUserId },
          });
        } else {
          // Standard notification for non-investment operations
          const notifTitle = isRoiWalletPayout && op.direction === "cash_in"
            ? "Partner Wallet Credited ✅"
            : op.direction === "cash_in" ? "Wallet Credited ✅" : "Wallet Debited ✅";
          await adminClient.from("notifications").insert({
            user_id: op.user_id,
            title: notifTitle,
            message: `UGX ${op.amount.toLocaleString()} - ${displayDescription || op.category}. Approved by admin.`,
            type: "success",
            metadata: { operation_id: op.id, amount: op.amount, direction: op.direction },
          });
        }

        results.push({ id: op.id, status: "approved", user_id: op.user_id, amount: op.amount });
      } else {
        // Reject
        await adminClient
          .from("pending_wallet_operations")
          .update({
            status: "rejected",
            reviewed_by: userId,
            reviewed_at: new Date().toISOString(),
            rejection_reason: rejection_reason,
            updated_at: new Date().toISOString(),
          })
          .eq("id", op.id);

        // If rejecting a supporter_facilitation_capital, cancel portfolio and restore agent wallet
        if (op.category === 'supporter_facilitation_capital' && op.source_table === 'investor_portfolios' && op.source_id) {
          // Cancel the portfolio
          await adminClient
            .from("investor_portfolios")
            .update({ status: "cancelled" })
            .eq("id", op.source_id)
            .eq("status", "pending_approval");

          // Find the agent who funded this and restore their wallet
          const { data: portfolio } = await adminClient
            .from("investor_portfolios")
            .select("agent_id, investment_amount")
            .eq("id", op.source_id)
            .single();

          if (portfolio) {
            // Restore agent wallet via ledger reversal (NOT direct wallet update)
            const { error: reversalErr } = await adminClient.rpc('create_ledger_transaction', {
              entries: [
                {
                  user_id: portfolio.agent_id,
                  amount: portfolio.investment_amount,
                  direction: 'cash_in',
                  category: 'system_balance_correction',
                  ledger_scope: 'wallet',
                  description: `Investment rejected — funds restored. Reason: ${rejection_reason}`,
                  source_table: 'investor_portfolios',
                  source_id: op.source_id,
                  currency: 'UGX',
                  transaction_date: new Date().toISOString(),
                },
                {
                  direction: 'cash_out',
                  amount: portfolio.investment_amount,
                  category: 'system_balance_correction',
                  ledger_scope: 'platform',
                  description: `Platform returns rejected investment capital`,
                  source_table: 'investor_portfolios',
                  source_id: op.source_id,
                  currency: 'UGX',
                  transaction_date: new Date().toISOString(),
                },
              ],
            });

            if (!reversalErr) {
              console.log(`[approve-wallet-op] Restored UGX ${portfolio.investment_amount} to agent ${portfolio.agent_id} via ledger`);
            } else {
              console.error(`[approve-wallet-op] Reversal ledger RPC failed:`, reversalErr);
            }

              // Notify agent of refund
              await adminClient.from("notifications").insert({
                user_id: portfolio.agent_id,
                title: "💰 Investment Refunded",
                message: `Your proxy investment of UGX ${portfolio.investment_amount.toLocaleString()} was rejected. Funds have been restored to your wallet. Reason: ${rejection_reason}`,
                type: "warning",
                metadata: { operation_id: op.id, amount: portfolio.investment_amount, reason: rejection_reason },
              });
          }
        }

        // Notify user
        await adminClient.from("notifications").insert({
          user_id: op.user_id,
          title: "Transaction Rejected ❌",
          message: `UGX ${op.amount.toLocaleString()} - ${op.description || op.category}. Reason: ${rejection_reason}`,
          type: "warning",
          metadata: { operation_id: op.id, amount: op.amount, reason: rejection_reason },
        });

        results.push({ id: op.id, status: "rejected", user_id: op.user_id, amount: op.amount });
      }
    }

    console.log(`[approve-wallet-op] Manager ${userId} ${action}d ${results.length} operations`);


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "✅ Wallet Operation", body: "Activity: wallet operation", url: "/dashboard/manager" }),
    }).catch(() => {});


    const approved_ids = results.filter(r => r.status === 'approved').map(r => r.id);
    const rejected_ids = results.filter(r => r.status === 'rejected').map(r => r.id);
    const failed_ids = failedResults.map(r => r.id);

    // If nothing succeeded, return an error
    if (results.length === 0 && failedResults.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `All ${failedResults.length} operation(s) failed`,
          failed_ids,
          failures: failedResults,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: results.length > 0,
        message: `${results.length} operation(s) ${action}d` + (failedResults.length > 0 ? `, ${failedResults.length} failed` : ''),
        results,
        approved_ids,
        rejected_ids,
        failed_ids,
        failures: failedResults.length > 0 ? failedResults : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[approve-wallet-op] Error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
