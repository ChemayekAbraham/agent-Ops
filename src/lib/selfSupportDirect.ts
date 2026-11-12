/**
 * Merchant-direct self-support: a partner's Rent Plan money goes straight to the
 * merchant payout queue; the merchant pays the landlord's approved number; the
 * portfolio becomes active then, and Rent Profit Share earns from the next day.
 * Not paid within 48 hours (or rejected): the partner's money comes back.
 *
 * Pure (no Supabase calls), so it is unit-tested. Data calls live in
 * src/hooks/useSelfSupportDirect.ts. Server truth: migrations
 * 20261117120000_self_support_merchant_direct.sql and
 * 20261117130000_self_support_staff_payments_list.sql.
 *
 * Copy rules: "Rent Plan", "Rent Profit Share", "partner"; never "loan",
 * "interest", "ROI" or "Returns".
 */

/** investor_portfolios.status while the merchant has not paid the landlord yet. */
export const AWAITING_LANDLORD_PAYMENT = 'awaiting_landlord_payment' as const;

export type LandlordPaymentStatus = 'queued' | 'paid' | 'refunded';

/** One row of self_support_my_landlord_payments(). */
export interface LandlordPayment {
  id: string;
  status: LandlordPaymentStatus;
  rent_request_id: string;
  amount: number;
  landlord_name: string | null;
  expires_at: string;
  paid_at: string | null;
  earning_from: string | null; // YYYY-MM-DD
  refunded_at: string | null;
  created_at: string;
  role: 'partner' | 'agent';
  tenant_first_name: string | null;
  my_share: number | null; // partner's own part (co-support: their half)
}

/** One row of self_support_staff_landlord_payments() (Financial Ops). */
export interface StaffLandlordPayment {
  id: string;
  status: LandlordPaymentStatus;
  rent_request_id: string;
  amount: number;
  landlord_name: string | null;
  landlord_phone: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  refund_reason: string | null;
  earning_from: string | null;
  stuck_flagged_at: string | null;
  overdue: boolean;
  withdrawal_id: string | null;
  withdrawal_status: string | null;
  merchant_claimed: boolean;
  landlord_payout_id: string | null;
  payout_status: string | null;
  payout_error: string | null;
  agent_id: string;
  agent_name: string | null;
  tenant_name: string | null;
  partners: Array<{ partner_id: string; name: string | null; share: number | null }> | null;
  can_refund: boolean;
  can_mark_paid: boolean;
}

export type StaffPaymentFilter = 'attention' | 'queued' | 'all';
export type StaffResolveOutcome = 'refund' | 'paid';

const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;

/** "13 Nov 2026" from a date-only string, without a timezone shift. */
export function formatDay(day: string | null | undefined): string {
  if (!day) return '';
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** Whole hours left before the 48-hour refund (0 once past). */
export function hoursLeft(expiresAt: string, now = Date.now()): number {
  const ms = new Date(expiresAt).getTime() - now;
  return ms > 0 ? Math.ceil(ms / 3_600_000) : 0;
}

/**
 * The state a screen shows. 'checking' = still queued past 48 hours: a merchant
 * claimed it or Financial Ops is checking; it is paid or refunded soon.
 */
export type LandlordPaymentState = 'waiting' | 'checking' | 'paid' | 'refunded';

export function landlordPaymentState(p: Pick<LandlordPayment, 'status' | 'expires_at'>, now = Date.now()): LandlordPaymentState {
  if (p.status === 'paid') return 'paid';
  if (p.status === 'refunded') return 'refunded';
  return new Date(p.expires_at).getTime() > now ? 'waiting' : 'checking';
}

export type CopyTone = 'pending' | 'success' | 'neutral';

export interface LandlordPaymentCopy {
  state: LandlordPaymentState;
  /** Short status label (badge). */
  label: string;
  /** One line under the label. */
  detail: string;
  tone: CopyTone;
}

/** Status copy for a partner's or an agent's landlord payment. */
export function landlordPaymentCopy(p: LandlordPayment, now = Date.now()): LandlordPaymentCopy {
  const state = landlordPaymentState(p, now);
  const landlord = p.landlord_name?.trim() || 'the landlord';
  const tenant = p.tenant_first_name?.trim() || 'the tenant';
  const amount = ugx(p.amount);
  const mine = ugx(p.my_share ?? p.amount);
  const isAgent = p.role === 'agent';

  switch (state) {
    case 'waiting': {
      const h = hoursLeft(p.expires_at, now);
      return {
        state,
        label: 'Waiting for the merchant to pay the landlord',
        detail: isAgent
          ? `A Welile merchant will pay ${landlord} ${amount} for ${tenant}. You do not handle this money.`
          : `A Welile merchant will pay ${landlord} ${amount} within ${h} ${h === 1 ? 'hour' : 'hours'}. `
            + 'Your Rent Profit Share starts the day after the landlord is paid.',
        tone: 'pending',
      };
    }
    case 'checking':
      return {
        state,
        label: 'Being checked',
        detail: isAgent
          ? `The payment to ${landlord} is taking longer than 48 hours. Welile is checking it.`
          : `The payment to ${landlord} is taking longer than 48 hours. Welile is checking it; `
            + `if the landlord was not paid, your ${mine} comes back to your float.`,
        tone: 'pending',
      };
    case 'paid':
      return {
        state,
        label: 'Landlord paid',
        detail: isAgent
          ? `${landlord} was paid ${amount} for ${tenant}. ${tenant} starts repaying the next day.`
          : `${landlord} was paid ${amount}. Your Rent Profit Share started on ${formatDay(p.earning_from)}.`,
        tone: 'success',
      };
    case 'refunded':
      return {
        state,
        label: 'Landlord not paid',
        detail: isAgent
          ? `The merchant could not pay ${landlord}, so the partner's money was returned. The Rent Plan is open for support again.`
          : `The merchant could not pay ${landlord}, so your ${mine} is back in your float. Nothing was lost.`,
        tone: 'neutral',
      };
  }
}

/** What funder_support_tenant_direct (and co_support_accept) return, the parts screens read. */
export interface SupportResultPayload {
  status?: string;
  funding_mode?: string;
  merchant_direct?: boolean;
  landlord_float_released?: boolean;
  awaiting_ops_approval?: boolean;
  from_float?: number;
  landlord_payments?: Array<Partial<LandlordPayment>>;
  landlord_payment?: Partial<LandlordPayment>;
  earning_from?: string;
  house_active?: boolean;
}

export type SupportOutcome =
  | 'merchant_queue'   // Rent Plan: money with the merchant, landlord paid soon
  | 'house_active'     // empty house: active at once
  | 'receivable'       // deposit promised, released when it lands
  | 'released_to_agent' // old path: rent on the agent's landlord float
  | 'pending_approval'; // old path: Partner Ops

export function supportOutcome(payload: SupportResultPayload | null | undefined): SupportOutcome {
  const p = payload ?? {};
  if (p.merchant_direct === true || p.status === AWAITING_LANDLORD_PAYMENT) return 'merchant_queue';
  if (p.house_active === true || (p.status === 'active' && !!p.earning_from && !p.landlord_float_released)) return 'house_active';
  if (p.funding_mode === 'receivable') return 'receivable';
  if (p.landlord_float_released === true) return 'released_to_agent';
  return 'pending_approval';
}

/** Toast after a partner supports (one place, so every support screen says the same). */
export function supportSubmittedCopy(payload: SupportResultPayload | null | undefined, total: number,
                                     opts: { depositDate?: string | null } = {}): { title: string; description: string } {
  const amount = ugx(total);
  switch (supportOutcome(payload)) {
    case 'merchant_queue':
      return {
        title: 'Sent to the merchant',
        description: `${amount} is on its way: a Welile merchant pays the landlord directly within 48 hours. `
          + 'Your Rent Profit Share starts the day after the landlord is paid. If the landlord cannot be paid, '
          + 'the money comes back to your float.',
      };
    case 'house_active':
      return {
        title: 'Support active',
        description: `${amount} is supporting the house now. Your Rent Profit Share starts on ${formatDay(payload?.earning_from)}.`,
      };
    case 'receivable':
      return {
        title: 'Support pledged',
        description: `Recorded as ${amount} you will deposit${opts.depositDate ? ` by ${formatDay(opts.depositDate)}` : ''}. `
          + 'It goes to the landlord once the deposit is in your wallet.',
      };
    case 'released_to_agent':
      return { title: 'Support sent', description: `${amount} is with the agent, who pays the landlord.` };
    case 'pending_approval':
      return {
        title: 'Submitted — pending approval',
        description: `${amount} is committed and waiting for Partner Operations to verify it.`,
      };
  }
}

/** Label for investor_portfolios.status values this flow adds (statements, lists). */
export const SELF_SUPPORT_PORTFOLIO_STATUS: Record<string, string> = {
  [AWAITING_LANDLORD_PAYMENT]: 'Paying landlord',
};

/** Financial Ops: why a payment needs attention, in one line. */
export function staffAttentionReason(p: StaffLandlordPayment, now = Date.now()): string {
  if (p.status !== 'queued') return p.status === 'paid' ? 'Landlord paid' : 'Partner refunded';
  if (p.payout_status === 'failed' && (p.withdrawal_status === 'processing' || p.can_mark_paid)) {
    return `Payout failed while the merchant withdrawal is ${p.withdrawal_status}: confirm with the merchant whether the landlord got the money.`;
  }
  if (p.can_mark_paid) return 'The merchant withdrawal is completed but the payout was not marked paid.';
  if (p.merchant_claimed && new Date(p.expires_at).getTime() <= now) {
    return 'Over 48 hours and claimed by a merchant, but not paid.';
  }
  if (new Date(p.expires_at).getTime() <= now) return 'Over 48 hours and not yet refunded.';
  if (p.stuck_flagged_at) return 'Flagged for Financial Ops.';
  return 'Waiting for a merchant.';
}

/** Client-side check that mirrors self_support_staff_resolve, so the button explains itself. */
export function staffResolveProblem(p: StaffLandlordPayment, outcome: StaffResolveOutcome, reason: string): string | null {
  if (p.status !== 'queued') return 'This payment is already settled.';
  if (reason.trim().length < 10) return 'Write a reason of at least 10 characters.';
  if (outcome === 'refund' && !p.can_refund) return 'The merchant withdrawal is completed: the landlord was paid. Resolve it as paid.';
  if (outcome === 'paid' && !p.can_mark_paid) return 'The merchant withdrawal is not completed: the landlord was not paid.';
  return null;
}

/** Server errors from the two staff calls, in plain words. */
export function staffResolveErrorMessage(err: unknown): string {
  const raw = String((err as { message?: string })?.message ?? err ?? '');
  if (raw.includes('only Financial Ops')) return 'Only Financial Ops can settle these payments.';
  if (raw.includes('PAYMENT_NOT_FOUND')) return 'This payment no longer exists. Refresh the list.';
  if (raw.includes('at least 10 characters')) return 'Write a reason of at least 10 characters.';
  const m = raw.match(/The merchant withdrawal is [^.]+\.[^.]*\./);
  return m ? m[0] : raw || 'Could not settle this payment.';
}

/** Steps a partner sees after supporting a Rent Plan that went to the merchant queue. */
export const MERCHANT_DIRECT_STEPS = [
  { title: 'With the merchant', text: 'A Welile merchant pays the landlord directly within 48 hours.' },
  { title: 'Landlord is paid', text: 'You get an SMS when the landlord is paid. If the landlord cannot be paid, your money comes back to your float.' },
  { title: 'Rent Profit Share starts', text: 'Your Rent Profit Share starts the day after the landlord is paid.' },
] as const;

/**
 * Merchant-direct refusals carry a code before the partner-facing sentence
 * (LANDLORD_NOT_READY, PLAN_AGENT_RESTRICTED). Returns the sentence, or null.
 */
export function supportErrorMessage(raw: string | null | undefined): string | null {
  const m = String(raw ?? '').match(/(?:LANDLORD_NOT_READY|PLAN_AGENT_RESTRICTED):\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}
