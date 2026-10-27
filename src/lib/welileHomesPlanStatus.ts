/**
 * Welile Homes plan status — the one browser definition of the approval stage shown on a
 * subscription and of whether its Delete control is offered.
 *
 * Inputs are only facts the database records against the subscription itself:
 *   - subscription_status ('cancelled' = application declined by operations)
 *   - funding_status (set only by the Welile Homes float functions; absent until
 *     docs/pending-migrations/welile_homes_float_link.sql is applied)
 *   - the status of the float request linked through welile_homes_float_request_items
 *     (same migration; absent before it)
 *   - whether any monthly due has a collection or landlord payout recorded
 *
 * Nothing is inferred from float request reason text: legacy requests carry no tenant or
 * landlord identity, so guessing attached the wrong stage to the wrong tenants.
 *
 * "Funded" is shown only when funding_status = 'funded' (written by wh_cfo_disburse_float in
 * the same transaction as the ledger posting). A request marked 'approved' without that proof
 * is shown as "Approved – disbursement unconfirmed".
 *
 * The delete lock here is presentation only. delete_welile_home_subscription refuses the same
 * plans on the server (docs/pending-migrations/welile_homes_delete_guard.sql).
 */
import { supabase } from '@/integrations/supabase/client';

export type WhPlanStage =
  | 'declined'
  | 'repaying'
  | 'funded'
  | 'approved_unconfirmed'
  | 'pending_cfo'
  | 'pending_coo'
  | 'pending_tenant_ops'
  | 'pending_agent_ops'
  | 'requested'
  | 'request_rejected'
  | 'not_requested';

export interface WhPlanFacts {
  subscriptionStatus?: string | null;
  /** undefined/null before the float-link migration is applied. */
  fundingStatus?: string | null;
  /** Status of the latest float request linked to this subscription, if any. */
  linkedRequestStatus?: string | null;
  /** Any due with amount collected or a landlord payout recorded. */
  hasCollections: boolean;
  /** True when the collections read failed: the plan is treated as locked. */
  collectionsUnknown?: boolean;
}

export interface WhStageMeta {
  label: string;
  description: string;
  tone: 'destructive' | 'success' | 'warning' | 'info' | 'violet' | 'neutral';
  isPending: boolean;
  /** Request Float may be offered from this stage. */
  canRequestFloat: boolean;
  /** Rent collection may be recorded from this stage. */
  canCollect: boolean;
}

export const WH_STAGE_META: Record<WhPlanStage, WhStageMeta> = {
  declined: {
    label: 'Application Declined',
    description: 'Declined by operations',
    tone: 'destructive', isPending: false, canRequestFloat: false, canCollect: false,
  },
  repaying: {
    label: 'Repaying',
    description: 'Rent collections are recorded on this plan',
    tone: 'success', isPending: false, canRequestFloat: false, canCollect: true,
  },
  funded: {
    label: 'Funded',
    description: 'CFO disbursement recorded',
    tone: 'success', isPending: false, canRequestFloat: false, canCollect: true,
  },
  approved_unconfirmed: {
    label: 'Approved – disbursement unconfirmed',
    description: 'Request marked approved, but no recorded CFO disbursement links it to this plan',
    // Upstream allowed collection once a request was approved; kept, only the label changed.
    tone: 'warning', isPending: false, canRequestFloat: false, canCollect: true,
  },
  pending_cfo: {
    label: 'Pending (CFO Allocation)',
    description: 'COO approved · awaiting CFO disbursement',
    tone: 'violet', isPending: true, canRequestFloat: false, canCollect: false,
  },
  pending_coo: {
    label: 'Pending (COO Approval)',
    description: 'Tenant Ops approved · awaiting COO approval',
    tone: 'info', isPending: true, canRequestFloat: false, canCollect: false,
  },
  pending_tenant_ops: {
    label: 'Pending (Tenant Ops)',
    description: 'Agent Ops approved · awaiting Tenant Ops review',
    tone: 'warning', isPending: true, canRequestFloat: false, canCollect: false,
  },
  pending_agent_ops: {
    label: 'Pending (Agent Ops)',
    description: 'Float requested · awaiting Agent Ops review',
    tone: 'warning', isPending: true, canRequestFloat: false, canCollect: false,
  },
  requested: {
    label: 'Float Requested',
    description: 'Float requested · stage not yet visible',
    tone: 'warning', isPending: true, canRequestFloat: false, canCollect: false,
  },
  request_rejected: {
    label: 'Float Rejected – can re-request',
    description: 'The float request was rejected; the tenant stays enrolled',
    tone: 'destructive', isPending: false, canRequestFloat: true, canCollect: false,
  },
  not_requested: {
    label: 'Float Not Requested',
    description: 'Enrolled · ready to request float',
    tone: 'neutral', isPending: false, canRequestFloat: true, canCollect: false,
  },
};

/** Pending stages in pipeline order (for steppers). */
export const WH_PENDING_STEPS: { stage: WhPlanStage; short: string }[] = [
  { stage: 'pending_agent_ops', short: '1. Agent Ops' },
  { stage: 'pending_tenant_ops', short: '2. Tenant Ops' },
  { stage: 'pending_coo', short: '3. COO' },
  { stage: 'pending_cfo', short: '4. CFO' },
];

function stageFromRequestStatus(status: string, fundingStatus?: string | null): WhPlanStage | null {
  switch (status) {
    case 'pending': return 'pending_agent_ops';
    case 'agent_ops_approved': return 'pending_tenant_ops';
    case 'tenant_ops_approved': return 'pending_coo';
    case 'coo_approved': return 'pending_cfo';
    case 'approved':
    case 'funded':
    case 'disbursed':
      return fundingStatus === 'funded' ? 'funded' : 'approved_unconfirmed';
    case 'rejected': return 'request_rejected';
    default: return null;
  }
}

export function resolveWhPlanStage(f: WhPlanFacts): WhPlanStage {
  if (f.subscriptionStatus === 'cancelled') return 'declined';
  if (f.hasCollections) return 'repaying';
  if (f.fundingStatus === 'funded') return 'funded';
  if (f.linkedRequestStatus) {
    const s = stageFromRequestStatus(f.linkedRequestStatus, f.fundingStatus);
    if (s) {
      // A rejected request releases the plan (funding_status back to 'unfunded').
      if (s === 'request_rejected' && f.fundingStatus === 'requested') return 'requested';
      return s;
    }
  }
  if (f.fundingStatus === 'requested') return 'requested';
  return 'not_requested';
}

/**
 * Whether the Delete control must be withheld. Fails closed: unknown collections lock.
 * Locked = money or a live request is attached to the plan.
 */
export function isWhPlanLocked(f: WhPlanFacts): boolean {
  if (f.collectionsUnknown) return true;
  if (f.hasCollections) return true;
  if (f.fundingStatus === 'requested' || f.fundingStatus === 'funded') return true;
  if (f.linkedRequestStatus && f.linkedRequestStatus !== 'rejected') return true;
  return false;
}

/** A due counts as a collection when money was collected or the landlord was paid. */
export function dueHasCollection(d: {
  amount_collected?: number | string | null;
  collection_status?: string | null;
  payout_status?: string | null;
}): boolean {
  if (Number(d.amount_collected) > 0) return true;
  if (d.collection_status === 'collected') return true;
  if (d.payout_status && d.payout_status !== 'unpaid') return true;
  return false;
}

