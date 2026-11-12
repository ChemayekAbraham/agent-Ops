/**
 * Self-support: activate on landlord paid.
 *
 * A partner supports a Rent Plan -> the rent goes to the agent's landlord float (no Partner Ops step) ->
 * the agent is informed -> the agent withdraws -> a Welile merchant pays the landlord -> the partner is
 * told -> the portfolio is active and Rent Profit Share starts that day. If the landlord is not paid within
 * 48 hours, the rent is recalled from the agent and the partner refunded. Empty houses are active at once.
 *
 * Pure (no Supabase calls), so it is unit-tested. Data calls live in src/hooks/useSelfSupportDirect.ts.
 * Server truth: migration 20261117140000_self_support_activate_on_landlord_paid.sql.
 *
 * Copy rules: "Rent Plan", "Rent Profit Share", "partner"; never "loan", "interest", "ROI" or "Returns".
 */

/** investor_portfolios.status while the landlord has not been paid yet. */
export const AWAITING_LANDLORD_PAYMENT = 'awaiting_landlord_payment' as const;

export type LandlordPaymentStatus = 'queued' | 'paid' | 'refunded';

/** One row of self_support_my_landlord_payments(): a partner-funded plan waiting for (or past) its landlord. */
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
  agent_id: string;
  agent_name: string | null;
  tenant_name: string | null;
  /** Rent still on the agent's landlord float for this plan. */
  float_remaining: number | null;
  /** Rent the agent already paid out to the landlord for this plan. */
  float_paid_out: number | null;
  /** The agent's latest landlord payout for this plan, if any. */
  payout_id: string | null;
  payout_status: string | null;
  payout_error: string | null;
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

/** Whole hours left before the 48-hour recall (0 once past). */
export function hoursLeft(expiresAt: string, now = Date.now()): number {
  const ms = new Date(expiresAt).getTime() - now;
  return ms > 0 ? Math.ceil(ms / 3_600_000) : 0;
}

/**
 * What a screen shows. 'checking' = still waiting past 48 hours: an agent payout is in progress
 * or Financial Ops is checking it; it ends paid or recalled.
 */
export type LandlordPaymentState = 'waiting' | 'checking' | 'paid' | 'refunded';

export function landlordPaymentState(p: Pick<LandlordPayment, 'status' | 'expires_at'>, now = Date.now()): LandlordPaymentState {
  if (p.status === 'paid') return 'paid';
  if (p.status === 'refunded') return 'refunded';
  return new Date(p.expires_at).getTime() > now ? 'waiting' : 'checking';
}

export type CopyTone = 'pending' | 'success' | 'neutral' | 'warning';

export interface LandlordPaymentCopy {
  state: LandlordPaymentState;
  /** Short status label (badge). */
  label: string;
  /** One line under the label. */
  detail: string;
  tone: CopyTone;
}

/** Status copy for a partner's or an agent's partner-funded plan. */
export function landlordPaymentCopy(p: LandlordPayment, now = Date.now()): LandlordPaymentCopy {
  const state = landlordPaymentState(p, now);
  const landlord = p.landlord_name?.trim() || 'the landlord';
  const tenant = p.tenant_first_name?.trim() || 'the tenant';
  const amount = ugx(p.amount);
  const mine = ugx(p.my_share ?? p.amount);
  const isAgent = p.role === 'agent';
  const h = hoursLeft(p.expires_at, now);
  const hours = `${h} ${h === 1 ? 'hour' : 'hours'}`;

  switch (state) {
    case 'waiting':
      return isAgent
        ? {
            state, tone: 'warning', label: 'Pay the landlord',
            detail: `${amount} for ${tenant} is on your landlord float. Pay ${landlord} within ${hours}, or it is recalled.`,
          }
        : {
            state, tone: 'pending', label: 'Waiting for the landlord to be paid',
            detail: `Your ${mine} is with the agent, who pays ${landlord} through a Welile merchant. `
              + 'Your portfolio becomes active and your Rent Profit Share starts the day the landlord is paid.',
          };
    case 'checking':
      return {
        state, tone: 'pending', label: 'Being checked',
        detail: isAgent
          ? `The payment to ${landlord} is taking longer than 48 hours. Financial Ops is checking it.`
          : `The payment to ${landlord} is taking longer than 48 hours. Welile is checking it; `
            + `if the landlord was not paid, your ${mine} comes back to your float.`,
      };
    case 'paid':
      return {
        state, tone: 'success', label: 'Landlord paid',
        detail: isAgent
          ? `${landlord} was paid ${amount} for ${tenant}. ${tenant} starts repaying the next day.`
          : `${landlord} was paid ${amount}. Your portfolio is active; Rent Profit Share started on ${formatDay(p.earning_from)}.`,
      };
    case 'refunded':
      return {
        state, tone: 'neutral', label: 'Recalled',
        detail: isAgent
          ? `The ${amount} for ${tenant} was recalled from your landlord float. Do not pay the landlord.`
          : `${landlord} was not paid within 48 hours, so your ${mine} is back in your float.`,
      };
  }
}

/** What funder_support_tenant_direct (and co_support_accept, partner_support_houses) return, the parts screens read. */
export interface SupportResultPayload {
  status?: string;
  funding_mode?: string;
  activates_when_landlord_paid?: boolean;
  landlord_float_released?: boolean;
  awaiting_ops_approval?: boolean;
  from_float?: number;
  landlord_payments?: Array<Partial<LandlordPayment>>;
  landlord_payment?: Partial<LandlordPayment>;
  earning_from?: string;
  house_active?: boolean;
}

export type SupportOutcome =
  | 'awaiting_landlord' // Rent Plan: rent on the agent's float, active once the landlord is paid
  | 'house_active'      // empty house: active at once
  | 'receivable'        // deposit promised, released when it lands
  | 'released_to_agent' // switch OFF: rent on the agent's float, portfolio active already
  | 'pending_approval'; // old path: Partner Ops

export function supportOutcome(payload: SupportResultPayload | null | undefined): SupportOutcome {
  const p = payload ?? {};
  if (p.activates_when_landlord_paid === true || p.status === AWAITING_LANDLORD_PAYMENT) return 'awaiting_landlord';
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
    case 'awaiting_landlord':
      return {
        title: 'Sent to the agent',
        description: `${amount} is on the agent's landlord float. Once a Welile merchant pays the landlord, your portfolio `
          + 'becomes active and your Rent Profit Share starts that day. If the landlord is not paid within 48 hours, '
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
          + 'It goes to the agent for the landlord once the deposit is in your wallet.',
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

/** Steps a partner sees after supporting a Rent Plan that activates when the landlord is paid. */
export const LANDLORD_PAID_STEPS = [
  { title: 'With the agent', text: 'Your rent is on the agent\'s landlord float. The agent pays the landlord through a Welile merchant.' },
  { title: 'Landlord is paid', text: 'You get an SMS and an email when the landlord is paid. If that does not happen within 48 hours, your money comes back to your float.' },
  { title: 'Portfolio active', text: 'Your Rent Profit Share starts the day the landlord is paid.' },
] as const;

/** Label for investor_portfolios.status values this flow adds (statements, lists). */
export const SELF_SUPPORT_PORTFOLIO_STATUS: Record<string, string> = {
  [AWAITING_LANDLORD_PAYMENT]: 'Waiting for landlord',
};

const PAYOUT_IN_FLIGHT = new Set(['otp_verified', 'pending_merchant_payout', 'pending_finops_disbursement', 'disbursing']);

/** Financial Ops: why a plan needs a person, in one line. */
export function staffAttentionReason(p: StaffLandlordPayment, now = Date.now()): string {
  if (p.status !== 'queued') return p.status === 'paid' ? 'Landlord paid' : 'Recalled, partner refunded';
  if (p.can_mark_paid) return 'The agent\'s landlord payout is paid but the portfolio is not active yet: mark it paid.';
  if (Number(p.float_paid_out ?? 0) > 0) return 'The landlord was partly paid: a recovery case, not a recall.';
  if (p.payout_status && PAYOUT_IN_FLIGHT.has(p.payout_status)) {
    return `An agent payout is in progress (${p.payout_status.replace(/_/g, ' ')}). Let the merchant settle it, or fail it before recalling.`;
  }
  if (new Date(p.expires_at).getTime() <= now) return 'Over 48 hours and the landlord is not paid: recall it.';
  if (p.stuck_flagged_at) return 'Flagged for Financial Ops.';
  return `Waiting for the agent to pay the landlord (${hoursLeft(p.expires_at, now)} h left).`;
}

/** Client-side check that mirrors self_support_staff_resolve, so the button explains itself. */
export function staffResolveProblem(p: StaffLandlordPayment, outcome: StaffResolveOutcome, reason: string): string | null {
  if (p.status !== 'queued') return 'This plan is already settled.';
  if (reason.trim().length < 10) return 'Write a reason of at least 10 characters.';
  if (outcome === 'refund' && !p.can_refund) {
    return Number(p.float_paid_out ?? 0) > 0
      ? 'The landlord was partly paid: this is a recovery case, not a recall.'
      : 'An agent payout for this plan is in progress or paid. Settle or fail it first.';
  }
  if (outcome === 'paid' && !p.can_mark_paid) return 'No paid agent payout for this plan yet: the landlord was not paid.';
  return null;
}

/** Server errors from the support, staff and payout calls, in plain words. */
export function staffResolveErrorMessage(err: unknown): string {
  const raw = String((err as { message?: string })?.message ?? err ?? '');
  if (raw.includes('only Financial Ops')) return 'Only Financial Ops can settle these plans.';
  if (raw.includes('PAYMENT_NOT_FOUND')) return 'This plan no longer exists. Refresh the list.';
  if (raw.includes('at least 10 characters')) return 'Write a reason of at least 10 characters.';
  if (raw.includes('Cannot recall')) return 'An agent payout for this plan is in progress or paid. Settle or fail it first.';
  if (raw.includes('No paid landlord payout')) return 'No paid agent payout for this plan yet: the landlord was not paid.';
  return raw || 'Could not settle this plan.';
}

/**
 * Coded refusals carry a code before the sentence meant for the person (e.g. RENT_RECALLED when an agent
 * tries to pay a landlord after a recall). Returns the sentence, or null.
 */
export function supportErrorMessage(raw: string | null | undefined): string | null {
  const m = String(raw ?? '').match(/(?:RENT_RECALLED):\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}
