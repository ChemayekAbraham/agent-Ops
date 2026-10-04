// Shared partnership email helpers used by every staff-driven (and self-service)
// portfolio flow. Centralising the payload shape avoids drift between
// fund-rent-pool, portfolio-topup, coo-create-portfolio, agent-invest-for-partner,
// approve-portfolio-topup, etc.
//
// All emails are sent via send-transactional-email which handles the unsubscribe
// token and suppression list. These helpers build the request body only.

const LOGO_URL = "https://welileapp.com/welile-logo.png";
const DASHBOARD_URL = "https://welileapp.com/auth";
const UNSUBSCRIBE_URL = "https://welile.com/unsubscribe";
const CONTACT_URL = "https://welile.com/contact";

import {
  type ReceiptAudience,
  commissionForAudience,
  assertReceiptContent,
} from "./receipt-content-policy.ts";
const COMPANY_NAME = "Welile";
const CURRENCY = "UGX";

function formatLongDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export interface PartnershipAgreementInput {
  recipientEmail: string;
  partnerName: string | null | undefined;
  partnerId: string;            // for idempotency key scoping
  portfolioId: string;          // for idempotency key scoping
  amount: number;
  monthlyReward: number;
  contributionDateIso: string;
  firstPayoutDateIso: string;
  payoutDay: number;
  /**
   * Agreed monthly ROI % for THIS portfolio (e.g. 15, 12.5, 10).
   * Optional — when omitted the template derives it from monthlyReward/amount.
   * Pass the actual investor_portfolios.roi_percentage so partners on
   * non-15% rates see their real rate in the email.
   */
  roiPercentage?: number;
}

export function buildPartnershipAgreementRequest(input: PartnershipAgreementInput) {
  const derivedPct = input.amount > 0
    ? Math.round((input.monthlyReward / input.amount) * 10000) / 100
    : 0;
  const pct = typeof input.roiPercentage === 'number' && input.roiPercentage > 0
    ? input.roiPercentage
    : derivedPct;
  return {
    templateName: "partnership-agreement",
    recipientEmail: input.recipientEmail,
    idempotencyKey: `partnership-agreement-${input.partnerId}-${input.portfolioId}`,
    templateData: {
      partner_name: input.partnerName || "Partner",
      partnership_amount: input.amount,
      contribution_date: formatLongDate(input.contributionDateIso),
      monthly_return_amount: input.monthlyReward,
      total_projected_return: input.monthlyReward * 12,
      roi_percentage: pct,
      first_payment_date: formatLongDate(input.firstPayoutDateIso),
      roi_payment_day: input.payoutDay,
      currency: CURRENCY,
      company_name: COMPANY_NAME,
      logo_url: LOGO_URL,
      dashboard_url: DASHBOARD_URL,
    },
  };
}

export interface PartnershipTopupInput {
  recipientEmail: string;
  partnerName: string | null | undefined;
  partnerId: string;             // idempotency scoping
  txGroupId: string;             // idempotency scoping (one email per top-up tx)
  topupAmount: number;
  previousPortfolioValue: number;
  newTotalPartnershipValue: number;
  /** Agreed monthly ROI % for the portfolio receiving this top-up. */
  roiPercentage?: number;
  /** Optional: monthly reward AMOUNT after top-up (UGX). Derived from roiPercentage * newTotal when omitted. */
  monthlyReturnAmount?: number;
  portfolioId?: string;
  portfolioName?: string;
  reviewedBy?: string;
  portfoliosToppedUpCount?: number;
  effectiveAt?: string;
  createdAt?: string;
}

export function buildPartnershipTopupRequest(input: PartnershipTopupInput) {
  const effectiveAt = input.effectiveAt || new Date().toISOString();
  const receiptNumber = `WELILE-TU-${input.txGroupId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  return {
    templateName: "partnership-topup",
    recipientEmail: input.recipientEmail,
    idempotencyKey: `partnership-topup-${input.partnerId}-${input.txGroupId}`,
    templateData: {
      partner_name: input.partnerName || "Partner",
      partner_id: input.partnerId,
      topup_amount: input.topupAmount,
      previous_portfolio_value: input.previousPortfolioValue,
      new_total_partnership_value: input.newTotalPartnershipValue,
      roi_percentage: typeof input.roiPercentage === 'number' && input.roiPercentage > 0
        ? input.roiPercentage
        : undefined,
      monthly_return_amount: typeof input.monthlyReturnAmount === 'number' && input.monthlyReturnAmount > 0
        ? input.monthlyReturnAmount
        : undefined,
      receipt_number: receiptNumber,
      effective_datetime: effectiveAt,
      parent_portfolio_id: input.portfolioId || input.txGroupId,
      portfolio_name: input.portfolioName || "Partnership Portfolio",
      portfolios_topped_up_count: input.portfoliosToppedUpCount || 1,
      created_at: input.createdAt || effectiveAt,
      reviewed_by: input.reviewedBy || "System",
      currency: CURRENCY,
      company_name: COMPANY_NAME,
      logo_url: LOGO_URL,
      unsubscribe_url: UNSUBSCRIBE_URL,
      dashboard_url: DASHBOARD_URL,
    },
  };
}

export interface PartnerCompoundInput {
  recipientEmail: string;
  partnerName: string | null | undefined;
  partnerId: string;             // idempotency scoping
  portfolioId: string;           // idempotency scoping + shown in email
  paymentNumber: number;         // idempotency scoping (one email per cycle)
  initialAmount: number;         // portfolio value before compounding
  roiPercentage?: number;        // e.g. 15 for "15%"; derived from amounts when omitted
  returnAmount: number;          // monetary amount earned this cycle
  newTotal: number;              // portfolio value after compounding
  compoundDateIso?: string;      // defaults to now
  contributionDateIso?: string;  // portfolio contribution/start date — anchors the projection
  durationMonths?: number;       // portfolio term in months (defaults to 12)
}

function ordinalDay(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

function formatOrdinalDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const day = d.getDate();
  const month = d.toLocaleDateString("en-GB", { month: "long" });
  const year = d.getFullYear();
  return `${ordinalDay(day)} of ${month}, ${year}`;
}

function shortPortfolioId(portfolioId: string): string {
  // Render UUID as PF-XXXXXXXX (first 8 chars of the hex, uppercased)
  const compact = portfolioId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `PF-${compact}`;
}

export function buildPartnerCompoundRequest(input: PartnerCompoundInput) {
  const compoundIso = input.compoundDateIso || new Date().toISOString();
  const contributionIso = input.contributionDateIso || compoundIso;
  const derivedPct = input.initialAmount > 0
    ? Math.round((input.returnAmount / input.initialAmount) * 10000) / 100
    : 0;
  const pct = typeof input.roiPercentage === 'number' && input.roiPercentage > 0
    ? input.roiPercentage
    : derivedPct;
  return {
    // Existing partners (auto cron compound on a live portfolio).
    // First-time partners who choose compound at portfolio creation
    // still use the original `partner-compound` template.
    templateName: "partner-portfolio-compounded",
    recipientEmail: input.recipientEmail,
    idempotencyKey: `partner-portfolio-compounded-${input.partnerId}-${input.portfolioId}-${input.paymentNumber}`,
    templateData: {
      partner_name: input.partnerName || "Partner",
      portfolio_id: shortPortfolioId(input.portfolioId),
      compound_date: formatOrdinalDate(compoundIso),
      initial_partnership_amount: input.initialAmount,
      roi_return: `${pct}%`,
      roi_percentage: pct,
      return_amount: input.returnAmount,
      new_total_partnership_value: input.newTotal,
      // Cycle index for this compounding event (1-based). The template
      // uses this to reconstruct a per-cycle breakdown that adds up to
      // the new total partnership value.
      payment_number: input.paymentNumber,
      // Anchor + term for the forward-looking remaining-months projection.
      contribution_date: formatOrdinalDate(contributionIso),
      duration_months: typeof input.durationMonths === 'number' && input.durationMonths > 0
        ? input.durationMonths
        : 12,
      currency: CURRENCY,
      company_name: COMPANY_NAME,
      logo_url: LOGO_URL,
      unsubscribe_url: UNSUBSCRIBE_URL,
      dashboard_url: DASHBOARD_URL,
    },
  };
}

export interface PartnerCompoundCreationInput {
  recipientEmail: string;
  partnerName: string | null | undefined;
  partnerId: string;             // idempotency scoping
  portfolioId: string;           // idempotency scoping + shown in email
  initialAmount: number;         // portfolio principal at creation
  roiPercentage: number;         // agreed monthly ROI % for this portfolio
  contributionDateIso?: string;  // defaults to now — drives the projection start
}

/**
 * Compound email sent when a partner chooses the COMPOUNDING ROI mode at
 * portfolio creation. Uses the rich `partner-compound` template which renders
 * the full month-by-month compounding breakdown working forward from the
 * new principal. Mirrors the auto-cron compound email flow but for the very
 * first cycle (payment_number = 1).
 */
export function buildPartnerCompoundCreationRequest(input: PartnerCompoundCreationInput) {
  const contributionIso = input.contributionDateIso || new Date().toISOString();
  const pct = input.roiPercentage > 0 ? input.roiPercentage : 0;
  const returnAmount = Math.round(input.initialAmount * (pct / 100));
  const newTotal = input.initialAmount + returnAmount;
  return {
    templateName: "partner-compound",
    recipientEmail: input.recipientEmail,
    idempotencyKey: `partner-compound-creation-${input.partnerId}-${input.portfolioId}`,
    templateData: {
      partner_name: input.partnerName || "Partner",
      portfolio_id: shortPortfolioId(input.portfolioId),
      compound_date: formatOrdinalDate(contributionIso),
      initial_partnership_amount: input.initialAmount,
      roi_return: `${pct}%`,
      roi_percentage: pct,
      return_amount: returnAmount,
      new_total_partnership_value: newTotal,
      payment_number: 1,
      currency: CURRENCY,
      company_name: COMPANY_NAME,
      logo_url: LOGO_URL,
      unsubscribe_url: UNSUBSCRIBE_URL,
      dashboard_url: DASHBOARD_URL,
    },
  };
}

export interface ReturnsDisbursementInput {
  recipientEmail: string;
  partnerName: string | null | undefined;
  partnerId: string;
  txGroupId: string;             // idempotency scoping
  amount: number;
  transactionId: string;         // human-readable ref shown in email
  portfolioCode?: string;
  walletIdLast4?: string;
  payoutMethod?: string;         // e.g. "Wallet" / "Mobile Money"
  isManagedByAgent?: boolean;
  agentName?: string;
  /** Agreed monthly ROI % of the source portfolio (e.g. 15, 12, 10). */
  roiPercentage?: number;
  /** Source portfolio principal (UGX). Enables % derivation if roiPercentage is omitted. */
  principalAmount?: number;
}

export function buildReturnsDisbursementRequest(input: ReturnsDisbursementInput) {
  return {
    templateName: "returns-disbursement-confirmation",
    recipientEmail: input.recipientEmail,
    idempotencyKey: `returns-disbursement-${input.partnerId}-${input.txGroupId}`,
    templateData: {
      partner_name: input.partnerName || "Partner",
      transaction_id: input.transactionId,
      portfolio_code: input.portfolioCode || "",
      amount: input.amount,
      currency: CURRENCY,
      date: new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
      payout_method: input.payoutMethod || "Wallet",
      payout_method_last4digit: input.walletIdLast4 || "",
      company_name: COMPANY_NAME,
      logo_url: LOGO_URL,
      is_managed_by_agent: !!input.isManagedByAgent,
      agent_name: input.agentName || "",
      roi_percentage: typeof input.roiPercentage === 'number' && input.roiPercentage > 0
        ? input.roiPercentage
        : undefined,
      principal_amount: typeof input.principalAmount === 'number' && input.principalAmount > 0
        ? input.principalAmount
        : undefined,
      unsubscribe_url: UNSUBSCRIBE_URL,
      contact_url: CONTACT_URL,
    },
  };
}

export interface ReturnsProcessingInput {
  recipientEmail: string;
  partnerName: string | null | undefined;
  partnerId: string;
  txGroupId: string;             // idempotency scoping
  amount: number;
  transactionId: string;         // human-readable ref shown in email
  portfolioCode?: string;
  payoutMethod?: string;         // e.g. "Wallet"
  isManagedByAgent?: boolean;
  agentName?: string;
}

/**
 * Stage 1 partner email: sent immediately after ROI is APPROVED and wallet-credited
 * by process-supporter-roi. Tells the partner the payout has been approved and is
 * being prepared. The final Stage 2 confirmation email (returns-disbursement-confirmation)
 * is only sent later once the payout has actually been paid out via approve-withdrawal.
 */
export function buildReturnsProcessingRequest(input: ReturnsProcessingInput) {
  return {
    templateName: "partnership-returns-processing",
    recipientEmail: input.recipientEmail,
    idempotencyKey: `returns-processing-${input.partnerId}-${input.txGroupId}`,
    templateData: {
      partner_name: input.partnerName || "Partner",
      transaction_id: input.transactionId,
      portfolio_code: input.portfolioCode || "",
      amount: input.amount,
      currency: CURRENCY,
      date: new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
      payout_method: input.payoutMethod || "Wallet",
      is_managed_by_agent: !!input.isManagedByAgent,
      agent_name: input.agentName || "",
      company_name: COMPANY_NAME,
      logo_url: LOGO_URL,
      unsubscribe_url: UNSUBSCRIBE_URL,
      contact_url: CONTACT_URL,
    },
  };
}

export interface WithdrawalPaidReceiptInput {
  recipientEmail: string;
  recipientName?: string | null;
  /** Used to scope the idempotency key (one fallback email per withdrawal). */
  withdrawalId: string;
  amount: number;
  paymentMethod: string;
  /** Friendly proof label, e.g. "Mobile Money transaction ID". */
  proofLabel: string;
  /** The actual proof reference the merchant entered. */
  proofReference: string;
  /** Post-debit withdrawable balance; null when it could not be resolved. */
  newBalance?: number | null;
  /** Public proof-of-payment receipt link (same one sent by SMS/WhatsApp). */
  receiptUrl?: string | null;
  /**
   * When set, renders an internal "receipt copy" (for the merchant agent,
   * Financial Ops, CFO or the records archive) instead of the customer copy.
   * The string labels who the copy is for, e.g. "Financial Ops".
   */
  copyFor?: string | null;
  /** Extra suffix so each recipient gets its own idempotent email. */
  idempotencySuffix?: string | null;
  /** Merchant-only: commission the processing agent earned on this payout. */
  commissionEarned?: number | null;
}

/**
 * Fallback "withdrawal paid" receipt, sent ONLY when the SMS confirmation
 * could not be delivered. Carries the same proof reference and updated wallet
 * balance the SMS would have shown so the user is never left uninformed.
 */
export function buildWithdrawalPaidReceiptRequest(input: WithdrawalPaidReceiptInput) {
  // Resolve who this receipt is for. Only the merchant agent's own copy may
  // carry commission; the customer's primary receipt and every internal copy
  // (FinOps / CFO / records archive) must not.
  const audience: ReceiptAudience = !input.copyFor
    ? "customer"
    : input.copyFor === "Merchant Agent"
      ? "merchant"
      : "internal";
  const commissionEarned = commissionForAudience(audience, input.commissionEarned);
  // Enforce the content rule before the email is built: customer/internal
  // receipts never include commission; merchant receipts always do.
  assertReceiptContent(audience, commissionEarned !== null);
  return {
    templateName: "withdrawal-paid-receipt",
    recipientEmail: input.recipientEmail,
    idempotencyKey:
      `withdrawal-paid-receipt-${input.withdrawalId}` +
      (input.idempotencySuffix ? `-${input.idempotencySuffix}` : ""),
    templateData: {
      recipient_name: input.recipientName || "there",
      amount: input.amount,
      currency: CURRENCY,
      payment_method: input.paymentMethod || "your selected method",
      proof_label: input.proofLabel || "Transaction ID",
      proof_reference: input.proofReference || "",
      new_balance:
        typeof input.newBalance === "number" && Number.isFinite(input.newBalance)
          ? input.newBalance
          : null,
      date: new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
      wallet_url: DASHBOARD_URL,
      receipt_url: input.receiptUrl || null,
      copy_for: input.copyFor || null,
      commission_earned: commissionEarned,
      unsubscribe_url: UNSUBSCRIBE_URL,
      contact_url: CONTACT_URL,
    },
  };
}

/**
 * Fire-and-forget POST to the send-transactional-email edge function.
 * Never throws — failures are logged to console only so the calling flow
 * is unaffected.
 */
export function dispatchTransactionalEmail(
  supabaseUrl: string,
  serviceKey: string,
  request: Record<string, unknown>,
  logTag = "partnership-emails",
) {
  fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(request),
  }).catch((err) =>
    console.warn(`[${logTag}] transactional email enqueue failed:`, err),
  );
}

/**
 * Look up the active, approved, MANAGED proxy assignment for a partner.
 * Returns the agent's profile when the partner is "managed by a proxy
 * agent" (is_managed_account=true). Otherwise returns null.
 *
 * When a managed proxy exists, wallet-bound payouts MUST be routed to the
 * agent's wallet, and the partner gets a notification email naming the
 * agent. The agent gets a separate "proxy payout received" email.
 */
export async function resolveManagedProxy(
  supabase: any,
  partnerId: string,
): Promise<null | {
  assignmentId: string;
  agentId: string;
  agentName: string | null;
  agentEmail: string | null;
}> {
  if (!partnerId) return null;
  const { data: assignment, error } = await supabase
    .from('proxy_agent_assignments')
    .select('id, agent_id, is_managed_account, is_active, approval_status')
    .eq('beneficiary_id', partnerId)
    .eq('is_active', true)
    .eq('is_managed_account', true)
    .eq('approval_status', 'approved')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !assignment) return null;

  const { data: agentProfile } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', assignment.agent_id)
    .maybeSingle();

  return {
    assignmentId: assignment.id,
    agentId: assignment.agent_id,
    agentName: agentProfile?.full_name ?? null,
    agentEmail: agentProfile?.email ?? null,
  };
}

export interface ProxyManagedPayoutInput {
  recipientEmail: string;
  agentName: string | null | undefined;
  agentId: string;
  partnerName: string | null | undefined;
  partnerId: string;
  amount: number;
  transactionId: string;
  txGroupId: string;            // idempotency scoping
  payoutKind?: string;          // e.g. "Monthly Returns"
  reason?: string;
}

export function buildProxyManagedPayoutRequest(input: ProxyManagedPayoutInput) {
  return {
    templateName: 'proxy-managed-payout-notice',
    recipientEmail: input.recipientEmail,
    idempotencyKey: `proxy-managed-payout-${input.agentId}-${input.partnerId}-${input.txGroupId}`,
    templateData: {
      agent_name: input.agentName || 'Agent',
      partner_name: input.partnerName || 'your partner',
      amount: input.amount,
      currency: CURRENCY,
      transaction_id: input.transactionId,
      payout_kind: input.payoutKind || 'Returns Payout',
      date: formatLongDate(new Date().toISOString()),
      reason: input.reason || 'Managed Proxy Account',
    },
  };
}

/**
 * Decide WHOSE wallet an outgoing-payout email charge should hit.
 *
 * Rules (email-payout auto-debit):
 *   1. If the matched user can cover the full amount → debit the user.
 *   2. If the matched user has INSUFFICIENT balance but has an active,
 *      approved, MANAGED proxy agent → skip the user entirely and debit the
 *      proxy agent's wallet for the full amount (clamped to the proxy's
 *      strict available balance; partial allowed).
 *   3. Otherwise (no managed proxy, or proxy has no balance) → fall back to a
 *      partial debit of the user up to their available balance.
 *   4. If nothing can be debited anywhere → returns null (caller skips).
 *
 * Always uses the strict `get_user_available_balance` RPC so the ledger never
 * blocks the debit.
 */
export async function resolvePayoutDebitTarget(
  supabase: any,
  matched: { id: string; full_name: string | null; phone: string | null },
  amount: number,
): Promise<
  | null
  | {
      targetUserId: string;
      targetName: string | null;
      targetPhone: string | null;
      available: number;
      debitAmount: number;
      isPartial: boolean;
      viaProxy: boolean;
      proxyForUserId: string | null;
      proxyForName: string | null;
    }
> {
  if (!matched?.id || !(amount > 0)) return null;

  const { data: availRaw } = await supabase.rpc('get_user_available_balance', {
    p_user_id: matched.id,
  });
  const avail = Number(availRaw ?? 0);

  // 1. User can cover the full amount → debit the user.
  if (Number.isFinite(avail) && avail >= amount) {
    return {
      targetUserId: matched.id,
      targetName: matched.full_name,
      targetPhone: matched.phone,
      available: avail,
      debitAmount: amount,
      isPartial: false,
      viaProxy: false,
      proxyForUserId: null,
      proxyForName: null,
    };
  }

  // 2. Insufficient balance → managed-proxy fallback (debit proxy, skip user).
  const proxy = await resolveManagedProxy(supabase, matched.id);
  if (proxy?.agentId) {
    const { data: pRaw } = await supabase.rpc('get_user_available_balance', {
      p_user_id: proxy.agentId,
    });
    const pAvail = Number(pRaw ?? 0);
    if (Number.isFinite(pAvail) && pAvail > 0) {
      const { data: pProfile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', proxy.agentId)
        .maybeSingle();
      const debitAmt = Math.min(amount, Math.floor(pAvail));
      return {
        targetUserId: proxy.agentId,
        targetName: proxy.agentName,
        targetPhone: pProfile?.phone ?? null,
        available: pAvail,
        debitAmount: debitAmt,
        isPartial: debitAmt < amount,
        viaProxy: true,
        proxyForUserId: matched.id,
        proxyForName: matched.full_name,
      };
    }
  }

  // 3. No managed proxy (or proxy empty) → partial user debit if any balance.
  if (Number.isFinite(avail) && avail > 0) {
    const debitAmt = Math.min(amount, Math.floor(avail));
    return {
      targetUserId: matched.id,
      targetName: matched.full_name,
      targetPhone: matched.phone,
      available: avail,
      debitAmount: debitAmt,
      isPartial: debitAmt < amount,
      viaProxy: false,
      proxyForUserId: null,
      proxyForName: null,
    };
  }

  // 4. Nothing to debit anywhere.
  return null;
}

/**
 * Record an audit-log entry for the email-payout proxy fallback path:
 * the matched user was SKIPPED because of insufficient balance and the
 * active managed proxy agent's wallet was debited instead.
 *
 * Captures the originating email id(s), the skipped user, and the chosen
 * debit target so Financial Ops can trace every proxy-substituted charge.
 * Never throws — failures are logged to console only.
 */
export async function logProxyFallbackAudit(
  supabase: any,
  args: {
    actorId: string | null;
    source: 'auto_poll' | 'backlog_sweep';
    gmailTransactionId: string | null;
    gmailMessageId: string | null;
    emailTid: string | null;
    skippedUserId: string;
    skippedUserName: string | null;
    proxyUserId: string;
    proxyUserName: string | null;
    requestedAmount: number;
    debitedAmount: number;
    isPartial: boolean;
    ledgerReferenceId: string | null;
  },
): Promise<void> {
  const emailRef =
    args.emailTid ||
    args.gmailTransactionId ||
    args.gmailMessageId ||
    'unknown';
  try {
    await supabase.from('audit_logs').insert({
      user_id: args.actorId,
      action_type: 'email_payout_proxy_fallback_debit',
      table_name: 'wallets',
      record_id: args.proxyUserId,
      action:
        `Email payout ${emailRef}: skipped ${args.skippedUserName ?? args.skippedUserId} ` +
        `(insufficient balance) — debited managed proxy ${args.proxyUserName ?? args.proxyUserId} instead`,
      metadata: {
        source: args.source,
        reason:
          'Email payout auto-debit: matched user had insufficient withdrawable ' +
          'balance; charged the active managed proxy wallet instead.',
        email: {
          gmail_transaction_id: args.gmailTransactionId,
          gmail_message_id: args.gmailMessageId,
          email_tid: args.emailTid,
        },
        skipped_user: { id: args.skippedUserId, name: args.skippedUserName },
        debited_target: {
          id: args.proxyUserId,
          name: args.proxyUserName,
          via_proxy: true,
        },
        requested_amount: args.requestedAmount,
        debited_amount: args.debitedAmount,
        is_partial: args.isPartial,
        ledger_reference_id: args.ledgerReferenceId,
      },
    });
  } catch (e) {
    console.warn('[partnership-emails] proxy fallback audit log failed (non-fatal):', e);
  }
}