import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendTenantSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "auto-charge-wallets" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username || !phone) return false;
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({ username, from: "WELILE", to: formatPhoneInternational(phone), message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch { return false; }
}

const GRACE_PERIOD_HOURS = 72;
const MAX_CONSECUTIVE_FAILURES = 3;

function daysBetween(dateStr: string, todayStr: string): number {
  const d1 = new Date(dateStr + "T00:00:00Z");
  const d2 = new Date(todayStr + "T00:00:00Z");
  return Math.floor((d2.getTime() - d1.getTime()) / 86400000);
}

/**
 * Calculate proportional fee split for a charge amount based on rent_request breakdown.
 */
interface FeeSplit {
  principalShare: number;
  accessShare: number;
  registrationShare: number;
}

async function getFeeSplit(
  supabase: ReturnType<typeof createClient>,
  rentRequestId: string | null,
  chargeAmount: number,
): Promise<FeeSplit> {
  if (!rentRequestId) {
    return { principalShare: chargeAmount, accessShare: 0, registrationShare: 0 };
  }

  const { data: rr } = await supabase
    .from("rent_requests")
    .select("rent_amount, access_fee, request_fee, total_repayment")
    .eq("id", rentRequestId)
    .single();

  if (!rr || !rr.total_repayment || rr.total_repayment <= 0) {
    return { principalShare: chargeAmount, accessShare: 0, registrationShare: 0 };
  }

  const principalShare = Math.round(chargeAmount * (Number(rr.rent_amount || 0) / Number(rr.total_repayment)));
  const accessShare = Math.round(chargeAmount * (Number(rr.access_fee || 0) / Number(rr.total_repayment)));
  const registrationShare = chargeAmount - principalShare - accessShare;

  return { principalShare, accessShare, registrationShare };
}

/**
 * Build proportional RPC entries for a tenant repayment (wallet cash_out + platform revenue split + bridge receivable reduction).
 */
function buildTenantRepaymentEntries(
  tenantId: string,
  amount: number,
  split: FeeSplit,
  chargeId: string,
  description: string,
  now: Date,
): any[] {
  const entries: any[] = [
    // 1. Tenant pays (wallet → platform cash movement)
    {
      user_id: tenantId,
      amount,
      direction: "cash_out",
      category: "tenant_repayment",
      source_table: "subscription_charges",
      source_id: chargeId,
      description,
      currency: "UGX",
      ledger_scope: "wallet",
      transaction_date: now.toISOString(),
    },
  ];

  // 2. Platform receives — split into revenue categories
  if (split.principalShare > 0) {
    entries.push({
      amount: split.principalShare,
      direction: "cash_in",
      category: "rent_principal_collected",
      source_table: "subscription_charges",
      source_id: chargeId,
      description: `Rent principal collected: ${description}`,
      currency: "UGX",
      ledger_scope: "platform",
      transaction_date: now.toISOString(),
    });
  }

  if (split.accessShare > 0) {
    entries.push({
      amount: split.accessShare,
      direction: "cash_in",
      category: "access_fee_collected",
      source_table: "subscription_charges",
      source_id: chargeId,
      description: `Access fee collected: ${description}`,
      currency: "UGX",
      ledger_scope: "platform",
      transaction_date: now.toISOString(),
    });
  }

  if (split.registrationShare > 0) {
    entries.push({
      amount: split.registrationShare,
      direction: "cash_in",
      category: "registration_fee_collected",
      source_table: "subscription_charges",
      source_id: chargeId,
      description: `Registration fee collected: ${description}`,
      currency: "UGX",
      ledger_scope: "platform",
      transaction_date: now.toISOString(),
    });
  }

  // 3. Reduce receivable (bridge scope)
  if (split.principalShare > 0) {
    entries.push({
      amount: split.principalShare,
      direction: "cash_out",
      category: "rent_principal_collected",
      source_table: "subscription_charges",
      source_id: chargeId,
      description: `Receivable reduction: ${description}`,
      currency: "UGX",
      ledger_scope: "bridge",
      transaction_date: now.toISOString(),
    });
  }

  return entries;
}

/**
 * Build LEDGER-ONLY accrual entries for a missed/unpaid instalment after the
 * 72-hour grace window. NO wallet leg is posted — wallets are not touched.
 *
 *  - bridge cash_in `rent_receivable_created` (full chargeAmount)
 *      → tenant now owes this instalment.
 *  - platform cash_in `access_fee_collected` (accessShare)
 *      → revenue earned on the access-fee portion (accrual basis).
 *  - platform cash_in `registration_fee_collected` (registrationShare)
 *      → revenue earned on the registration-fee portion (accrual basis).
 *
 * Principal portion is NOT recognised as platform revenue (it is a
 * pass-through Welile already disbursed to the landlord). It only adds
 * to the receivable so it can be netted against future cash repayments.
 */
function buildAccrualEntriesNoWallet(
  tenantId: string,
  landlordId: string | null,
  chargeAmount: number,
  split: FeeSplit,
  chargeId: string,
  rentRequestId: string | null,
  description: string,
  now: Date,
): any[] {
  const entries: any[] = [
    {
      user_id: tenantId,
      linked_party: landlordId ?? undefined,
      amount: chargeAmount,
      direction: "cash_in",
      category: "rent_receivable_created",
      source_table: "subscription_charges",
      source_id: chargeId,
      description: `Accrued (72h grace expired): ${description}`,
      currency: "UGX",
      ledger_scope: "bridge",
      transaction_date: now.toISOString(),
    },
  ];

  if (split.accessShare > 0) {
    entries.push({
      user_id: tenantId,
      amount: split.accessShare,
      direction: "cash_in",
      category: "access_fee_collected",
      source_table: "subscription_charges",
      source_id: chargeId,
      description: `Access fee accrued (72h grace expired): ${description}`,
      currency: "UGX",
      ledger_scope: "platform",
      transaction_date: now.toISOString(),
    });
  }

  if (split.registrationShare > 0) {
    entries.push({
      user_id: tenantId,
      amount: split.registrationShare,
      direction: "cash_in",
      category: "registration_fee_collected",
      source_table: "subscription_charges",
      source_id: chargeId,
      description: `Registration fee accrued (72h grace expired): ${description}`,
      currency: "UGX",
      ledger_scope: "platform",
      transaction_date: now.toISOString(),
    });
  }

  return entries;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Treasury guard: cron auto-charges debit user wallets — block when paused
    const guardBlock = await checkTreasuryGuard(supabase, "any");
    if (guardBlock) return guardBlock;

    const today = new Date().toISOString().split("T")[0];
    const now = new Date();

    console.log(`[auto-charge-wallets] Processing charges due on or before ${today}`);

    const { data: dueCharges, error: fetchError } = await supabase
      .from("subscription_charges")
      .select("*")
      .in("status", ["active"])
      .lte("next_charge_date", today);

    if (fetchError) {
      throw new Error(`Failed to fetch due charges: ${fetchError.message}`);
    }

    if (!dueCharges || dueCharges.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No charges due today", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[auto-charge-wallets] Found ${dueCharges.length} due charges`);

    const results = {
      processed: 0,
      successful: 0,
      partial: 0,
      insufficient: 0,
      agent_charged: 0,
      grace_period: 0,
      completed: 0,
      catchup_debt: 0,
      stalled: 0,
      totalCharged: 0,
      totalDebt: 0,
      totalAgentCharged: 0,
      totalCatchupDebt: 0,
      errors: [] as string[],
    };

    for (const charge of dueCharges) {
      try {
        results.processed++;

        const { data: tenantProfile } = await supabase
          .from("profiles")
          .select("full_name, phone")
          .eq("id", charge.tenant_id)
          .single();
        const tenantName = tenantProfile?.full_name || "Unknown Tenant";
        const tenantPhone = tenantProfile?.phone || "";
        const chargeAmount = Number(charge.charge_amount);

        // =====================================================
        // PART 1: CATCH-UP LOGIC — Skip stale backlog dates
        // =====================================================
        const missedDays = daysBetween(charge.next_charge_date, today);

        if (missedDays > 1) {
          let missedPeriods: number;
          if (charge.frequency === "daily") missedPeriods = missedDays;
          else if (charge.frequency === "weekly") missedPeriods = Math.floor(missedDays / 7);
          else missedPeriods = Math.floor(missedDays / 30);

          missedPeriods = Math.min(missedPeriods, charge.charges_remaining);

          if (missedPeriods > 0) {
            const catchupDebt = chargeAmount * missedPeriods;

            console.log(`[auto-charge-wallets] CATCH-UP: ${tenantName} has ${missedDays} stale days (${missedPeriods} missed ${charge.frequency} periods). Recording UGX ${catchupDebt} as debt.`);

            await supabase.from("subscription_charge_logs").insert({
              subscription_id: charge.id,
              tenant_id: charge.tenant_id,
              charge_amount: catchupDebt,
              amount_deducted: 0,
              debt_added: catchupDebt,
              wallet_balance_before: 0,
              wallet_balance_after: 0,
              status: "catchup_debt",
              charge_date: today,
            });

            const newRemaining = Math.max(0, charge.charges_remaining - missedPeriods);
            const isComplete = newRemaining <= 0;

            await supabase.from("subscription_charges").update({
              accumulated_debt: Number(charge.accumulated_debt) + catchupDebt,
              charges_completed: charge.charges_completed + missedPeriods,
              charges_remaining: newRemaining,
              next_charge_date: isComplete ? charge.next_charge_date : today,
              status: isComplete ? "completed" : "active",
              tenant_failed_at: null,
              consecutive_failures: 0,
            }).eq("id", charge.id);

            if (charge.agent_id) {
              await supabase.from("notifications").insert({
                user_id: charge.agent_id,
                title: "📋 Missed Payments Recorded as Debt",
                message: `${tenantName} (${tenantPhone}): ${missedPeriods} missed ${charge.frequency} payments totaling UGX ${catchupDebt.toLocaleString()} recorded as debt. Schedule advanced to today.`,
                type: "warning",
                metadata: { subscription_id: charge.id, tenant_id: charge.tenant_id, missed_periods: missedPeriods, catchup_debt: catchupDebt },
              });
            }

            results.catchup_debt++;
            results.totalCatchupDebt += catchupDebt;

            if (isComplete) {
              results.completed++;
              console.log(`[auto-charge-wallets] ${tenantName}: completed after catch-up`);
              continue;
            }

            charge.next_charge_date = today;
            charge.charges_remaining = newRemaining;
            charge.charges_completed = charge.charges_completed + missedPeriods;
            charge.accumulated_debt = Number(charge.accumulated_debt) + catchupDebt;
            charge.tenant_failed_at = null;
            charge.consecutive_failures = 0;
          }
        }

        // If charge_agent_wallet flag is set (no smartphone), record as debt (agents are no longer charged)
        if (charge.charge_agent_wallet && charge.agent_id) {
          console.log(`[auto-charge-wallets] charge_agent_wallet=true for ${charge.tenant_id}, recording debt (agent not charged)`);
          const debtAdded = chargeAmount;
          const logStatus = "debt_recorded_no_smartphone";

          await logAndUpdateCharge(supabase, charge, {
            chargeAmount, amountDeducted: 0, agentAmountCharged: 0, debtAdded,
            walletBefore: 0, walletAfter: 0, logStatus, tenantName, tenantPhone, today,
          });

          if (charge.rent_request_id) {
            // Try the Treasury waterfall first (amount=0 is effectively a no-op allocation);
            // fall back to legacy repayment so a missing funding-side L7 credit never blocks processing.
            try {
              const { error: waterfallErr } = await supabase.rpc("record_rent_request_repayment_v2", {
                p_tenant_id: charge.tenant_id,
                p_amount: 0,
                p_source_table: "subscription_charges",
                p_source_id: charge.id,
              });
              if (waterfallErr) throw waterfallErr;
            } catch (waterfallErr: any) {
              console.error(`[auto-charge-wallets] Treasury waterfall failed for charge ${charge.id} (zero amount), falling back:`, waterfallErr?.message || waterfallErr);
              await supabase.rpc("record_rent_request_repayment", {
                p_tenant_id: charge.tenant_id, p_amount: 0,
              });
            }
          }

          await supabase.from("notifications").insert({
            user_id: charge.agent_id,
            title: "📋 No-Smartphone Tenant — Debt Recorded",
            message: `UGX ${chargeAmount.toLocaleString()} for ${tenantName}'s (${tenantPhone}) ${charge.frequency} rent instalment recorded as debt. Please collect from the tenant.`,
            type: "warning",
            metadata: { subscription_id: charge.id, tenant_id: charge.tenant_id, tenant_name: tenantName, tenant_phone: tenantPhone, amount: chargeAmount },
          });

          results.insufficient++;
          results.totalDebt += debtAdded;
          console.log(`[auto-charge-wallets] ${charge.tenant_id}: ${logStatus} (no-smartphone) - debt:${debtAdded}`);
          continue;
        }

        // === STANDARD FLOW: Try tenant wallet first ===
        const { data: wallet, error: walletError } = await supabase
          .from("wallets")
          .select("balance")
          .eq("user_id", charge.tenant_id)
          .single();

        const walletBalance = (!walletError && wallet) ? Number(wallet.balance) : 0;
        const hasSufficientFunds = walletBalance >= chargeAmount;

        // === TENANT CAN PAY: charge them with proportional revenue split ===
        if (hasSufficientFunds) {
          // Get proportional fee split
          const split = await getFeeSplit(supabase, charge.rent_request_id, chargeAmount);

          const { error: deductErr } = await supabase.rpc('create_ledger_transaction', {
            entries: 
              buildTenantRepaymentEntries(
                charge.tenant_id, chargeAmount, split, charge.id,
                `Auto-charge: ${charge.frequency} rent instalment for ${tenantName}`,
                now,
              )
            ,
          });

          if (deductErr) {
            console.error(`[auto-charge-wallets] RPC deduct error for ${charge.tenant_id}:`, deductErr);
            results.errors.push(`${charge.id}: Deduction failed`);
            continue;
          }

          const newBalance = walletBalance - chargeAmount;

          if (charge.rent_request_id) {
            // Try the Treasury waterfall first; fall back to legacy repayment so a
            // missing funding-side L7 credit never blocks the tenant's payment.
            try {
              const { error: waterfallErr } = await supabase.rpc("record_rent_request_repayment_v2", {
                p_tenant_id: charge.tenant_id,
                p_amount: chargeAmount,
                p_source_table: "subscription_charges",
                p_source_id: charge.id,
              });
              if (waterfallErr) throw waterfallErr;
              console.log(`[auto-charge-wallets] Treasury waterfall recorded for charge ${charge.id}`);
            } catch (waterfallErr: any) {
              console.error(`[auto-charge-wallets] Treasury waterfall failed for charge ${charge.id}, falling back to legacy repayment:`, waterfallErr?.message || waterfallErr);
              await supabase.rpc("record_rent_request_repayment", {
                p_tenant_id: charge.tenant_id, p_amount: chargeAmount,
              });
            }
            await supabase.rpc("credit_agent_rent_commission", {
              p_rent_request_id: charge.rent_request_id, p_repayment_amount: chargeAmount,
              p_tenant_id: charge.tenant_id,
              p_event_reference_id: `auto-charge-wallet-${charge.id}-${today}`,
            });
          }

          if (charge.tenant_failed_at || charge.consecutive_failures > 0) {
            await supabase.from("subscription_charges").update({
              tenant_failed_at: null,
              consecutive_failures: 0,
            }).eq("id", charge.id);
          }

          await logAndUpdateCharge(supabase, charge, {
            chargeAmount, amountDeducted: chargeAmount, agentAmountCharged: 0, debtAdded: 0,
            walletBefore: walletBalance, walletAfter: newBalance, logStatus: "success", tenantName, tenantPhone, today,
          });

          await supabase.from("notifications").insert({
            user_id: charge.tenant_id,
            title: "💳 Auto-Charge Processed",
            message: `UGX ${chargeAmount.toLocaleString()} deducted for your ${charge.service_type} instalment. ${Math.max(0, charge.charges_remaining - 1)} payments remaining.`,
            type: "info",
            metadata: { subscription_id: charge.id, amount: chargeAmount },
          });

          if (tenantPhone) {
            const remaining = Math.max(0, charge.charges_remaining - 1);
            const sms = `WELILE: Dear ${tenantName}, UGX ${chargeAmount.toLocaleString()} deducted from your wallet for rent. ${remaining > 0 ? `${remaining} payments left.` : 'Rent fully paid!'} Access up to UGX 30M credit with WELILE!`;
            sendTenantSMS(tenantPhone, sms).catch(e => console.error("[auto-charge-wallets] SMS error:", e));
          }

          results.successful++;
          results.totalCharged += chargeAmount;
          console.log(`[auto-charge-wallets] ${charge.tenant_id}: success - tenant:${chargeAmount}`);
          continue;
        }

        // === TENANT CANNOT PAY: Check 72-hour grace period ===
        const tenantFailedAt = charge.tenant_failed_at ? new Date(charge.tenant_failed_at) : null;

        if (!tenantFailedAt) {
          await supabase.from("subscription_charges").update({
            tenant_failed_at: now.toISOString(),
          }).eq("id", charge.id);

          console.log(`[auto-charge-wallets] ${charge.tenant_id}: Starting 72h grace period`);

          await supabase.from("notifications").insert({
            user_id: charge.tenant_id,
            title: "⚠️ Insufficient Wallet Balance",
            message: `Your instalment of UGX ${chargeAmount.toLocaleString()} could not be charged. You have 72 hours to top up before it is recorded as debt.`,
            type: "warning",
            metadata: { subscription_id: charge.id, amount: chargeAmount, grace_deadline: new Date(now.getTime() + GRACE_PERIOD_HOURS * 3600000).toISOString() },
          });

          if (charge.agent_id) {
            await supabase.from("notifications").insert({
              user_id: charge.agent_id,
              title: "⏳ Tenant Payment Pending — 72h Grace",
              message: `${tenantName} (${tenantPhone}) could not pay UGX ${chargeAmount.toLocaleString()}. If unpaid in 72 hours, it will be recorded as debt. Please follow up with the tenant.`,
              type: "info",
              metadata: { subscription_id: charge.id, tenant_id: charge.tenant_id, tenant_name: tenantName, tenant_phone: tenantPhone, amount: chargeAmount },
            });
          }

          results.grace_period++;
          continue;
        }

        // Check if grace period has elapsed
        const hoursSinceFailure = (now.getTime() - tenantFailedAt.getTime()) / 3600000;

        if (hoursSinceFailure < GRACE_PERIOD_HOURS) {
          console.log(`[auto-charge-wallets] ${charge.tenant_id}: Still in grace period (${Math.round(hoursSinceFailure)}h / ${GRACE_PERIOD_HOURS}h)`);
          results.grace_period++;
          continue;
        }

        // === GRACE PERIOD EXPIRED: Record debt (agents are no longer charged) ===
        console.log(`[auto-charge-wallets] ${charge.tenant_id}: Grace period expired (${Math.round(hoursSinceFailure)}h). Posting LEDGER-ONLY accrual (no wallet movement).`);

        // Resolve landlord (linked_party) for the receivable leg, best-effort.
        let landlordIdForAccrual: string | null = null;
        if (charge.rent_request_id) {
          const { data: rrLandlord } = await supabase
            .from("rent_requests")
            .select("landlord_id")
            .eq("id", charge.rent_request_id)
            .maybeSingle();
          landlordIdForAccrual = (rrLandlord?.landlord_id as string | null) ?? null;
        }

        // FORWARD-ONLY ACCRUAL: full instalment becomes a receivable, fee
        // shares recognised as revenue. NO wallets table is touched.
        const accrualSplit = await getFeeSplit(supabase, charge.rent_request_id, chargeAmount);

        // HARD WALLET GUARD: route through `create_ledger_transaction_accrual_only`
        // which (1) refuses any wallet-scoped leg in the payload and
        // (2) sets `wallet.accrual_lock=on` for the transaction so any
        // cascading trigger that tries to mutate a wallet bucket is rejected
        // by `enforce_wallet_ledger_only`. Wallets cannot be touched here.
        const accrualEntries = buildAccrualEntriesNoWallet(
          charge.tenant_id,
          landlordIdForAccrual,
          chargeAmount,
          accrualSplit,
          charge.id,
          charge.rent_request_id,
          `${charge.frequency} instalment for ${tenantName}`,
          now,
        );

        // Defensive client-side check — must never include a wallet leg.
        const walletLegs = accrualEntries.filter(
          (e: any) => String(e?.ledger_scope ?? "").toLowerCase() === "wallet",
        );
        if (walletLegs.length > 0) {
          console.error(
            `[auto-charge-wallets] BLOCKED: accrual payload for ${charge.tenant_id} contained ${walletLegs.length} wallet leg(s); refusing to post.`,
          );
          results.errors.push(`${charge.id}: wallet leg in accrual payload`);
          continue;
        }

        const { error: accrualErr } = await supabase.rpc(
          "create_ledger_transaction_accrual_only",
          { entries: accrualEntries },
        );

        if (accrualErr) {
          console.error(`[auto-charge-wallets] Accrual RPC error for ${charge.tenant_id}:`, accrualErr);
          results.errors.push(`${charge.id}: Accrual failed`);
          continue;
        }

        const amountDeducted = 0;          // wallets untouched by design
        const debtAdded = chargeAmount;    // full instalment now owed
        const logStatus = "accrued_no_wallet_72h";
        results.insufficient++;

        // GRACE CIRCUIT BREAKER
        const newFailures = (charge.consecutive_failures || 0) + 1;

        if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
          await supabase.from("subscription_charges").update({
            status: "stalled",
            consecutive_failures: newFailures,
            tenant_failed_at: null,
          }).eq("id", charge.id);

          const { data: managers } = await supabase
            .from("profiles")
            .select("id")
            .eq("role", "manager");

          if (managers && managers.length > 0) {
            const managerNotifications = managers.map((m: any) => ({
              user_id: m.id,
              title: "🛑 Charge Stalled — Manual Intervention Required",
              message: `${tenantName} (${tenantPhone}): ${newFailures} consecutive failed grace cycles. Tenant has insufficient funds. Charge amount: UGX ${chargeAmount.toLocaleString()}/day. Total accumulated debt: UGX ${(Number(charge.accumulated_debt) + debtAdded).toLocaleString()}.`,
              type: "warning",
              metadata: { subscription_id: charge.id, tenant_id: charge.tenant_id, agent_id: charge.agent_id, consecutive_failures: newFailures },
            }));
            await supabase.from("notifications").insert(managerNotifications);
          }

          if (charge.agent_id) {
            await supabase.from("notifications").insert({
              user_id: charge.agent_id,
              title: "🛑 Charge Stalled — Action Required",
              message: `After ${newFailures} failed attempts, rent collection for ${tenantName} (${tenantPhone}) has been paused. Please contact the tenant. Amount: UGX ${chargeAmount.toLocaleString()}.`,
              type: "warning",
              metadata: { subscription_id: charge.id, tenant_id: charge.tenant_id, amount: chargeAmount },
            });
          }

          results.stalled++;
          console.log(`[auto-charge-wallets] STALLED: ${tenantName} after ${newFailures} consecutive failures`);
        } else {
          await supabase.from("subscription_charges").update({
            consecutive_failures: newFailures,
            tenant_failed_at: null,
          }).eq("id", charge.id);

          console.log(`[auto-charge-wallets] ${tenantName}: failure #${newFailures}/${MAX_CONSECUTIVE_FAILURES}, grace reset`);
        }

        if (newFailures < MAX_CONSECUTIVE_FAILURES) {
          await supabase.from("subscription_charges").update({ tenant_failed_at: null }).eq("id", charge.id);
        }

        // Repayment / commission RPCs intentionally skipped — no cash moved,
        // these only fire on real wallet repayments.

        await logAndUpdateCharge(supabase, charge, {
          chargeAmount, amountDeducted, agentAmountCharged: 0, debtAdded,
          walletBefore: walletBalance, walletAfter: walletBalance - amountDeducted,
          logStatus, tenantName, tenantPhone, today,
        });

        // Notifications
        if (debtAdded > 0 && charge.agent_id) {
          await supabase.from("notifications").insert({
            user_id: charge.agent_id,
            title: "📋 Tenant Missed Payment — Debt Recorded",
            message: `${tenantName} (${tenantPhone}) couldn't cover UGX ${chargeAmount.toLocaleString()} after 72h grace. UGX ${debtAdded.toLocaleString()} recorded as tenant debt. Please follow up with the tenant.`,
            type: "warning",
            metadata: { subscription_id: charge.id, tenant_id: charge.tenant_id, tenant_name: tenantName, debt: debtAdded },
          });
        }

        if (debtAdded > 0) {
          await supabase.from("notifications").insert({
            user_id: charge.tenant_id,
            title: "⚠️ Missed Payment — Debt Recorded",
            message: `Your instalment of UGX ${debtAdded.toLocaleString()} could not be charged after 72 hours. This has been recorded as debt. Please top up your wallet.`,
            type: "warning",
            metadata: { subscription_id: charge.id, debt: debtAdded },
          });
        }

        results.totalCharged += amountDeducted;
        results.totalDebt += debtAdded;

        console.log(`[auto-charge-wallets] ${charge.tenant_id}: ${logStatus} - tenant:${amountDeducted}, debt:${debtAdded}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[auto-charge-wallets] Error processing ${charge.id}:`, msg);
        results.errors.push(`${charge.id}: ${msg}`);
      }
    }

    console.log(`[auto-charge-wallets] Done: ${results.successful} success, ${results.agent_charged} agent-covered, ${results.grace_period} grace-period, ${results.catchup_debt} catch-up, ${results.stalled} stalled, ${results.insufficient} insufficient`);

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[auto-charge-wallets] Fatal:", msg);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});

/**
 * Log charge attempt and update subscription totals.
 */
async function logAndUpdateCharge(
  supabase: ReturnType<typeof createClient>,
  charge: any,
  opts: {
    chargeAmount: number; amountDeducted: number; agentAmountCharged: number;
    debtAdded: number; walletBefore: number; walletAfter: number;
    logStatus: string; tenantName: string; tenantPhone: string; today: string;
  },
) {
  await supabase.from("subscription_charge_logs").insert({
    subscription_id: charge.id,
    tenant_id: charge.tenant_id,
    charge_amount: opts.chargeAmount,
    amount_deducted: opts.amountDeducted,
    debt_added: opts.debtAdded,
    wallet_balance_before: opts.walletBefore,
    wallet_balance_after: opts.walletAfter,
    status: opts.logStatus,
    charge_date: opts.today,
  });

  const totalCollected = opts.amountDeducted + opts.agentAmountCharged;
  const newTotalCharged = Number(charge.total_charged) + totalCollected;
  const newAccumulatedDebt = Number(charge.accumulated_debt) + opts.debtAdded;
  const newChargesCompleted = charge.charges_completed + 1;
  const newChargesRemaining = Math.max(0, charge.charges_remaining - 1);
  const newAgentChargedAmount = Number(charge.agent_charged_amount || 0) + opts.agentAmountCharged;
  const newAgentChargeCount = (charge.agent_charge_count || 0) + (opts.agentAmountCharged > 0 ? 1 : 0);

  const todayDate = new Date(opts.today + "T00:00:00Z");
  let nextDate: Date;
  if (charge.frequency === "daily") {
    nextDate = new Date(todayDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  } else if (charge.frequency === "weekly") {
    nextDate = new Date(todayDate);
    nextDate.setUTCDate(nextDate.getUTCDate() + 7);
  } else {
    nextDate = new Date(todayDate);
    nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
  }

  const isComplete = newChargesRemaining <= 0;

  await supabase.from("subscription_charges").update({
    total_charged: newTotalCharged,
    accumulated_debt: newAccumulatedDebt,
    charges_completed: newChargesCompleted,
    charges_remaining: newChargesRemaining,
    agent_charged_amount: newAgentChargedAmount,
    agent_charge_count: newAgentChargeCount,
    next_charge_date: isComplete ? charge.next_charge_date : nextDate.toISOString().split("T")[0],
    status: isComplete ? "completed" : "active",
  }).eq("id", charge.id);
}

