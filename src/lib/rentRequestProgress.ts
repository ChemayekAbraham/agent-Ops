/**
 * What a tenant sees about their own rent request, in plain words.
 *
 * Built only from the tenant's own `rent_requests` row (they may read it; the
 * stage-event and audit tables are staff-only). Every status that exists in
 * production as of 2026-11-14 is mapped:
 *   pending, service_center_review, partner_ops_approved, coo_approved,
 *   funded, repaying, completed, rejected, cancelled, deleted_by_agent.
 * Any status added later shows as "checking your details", never as approved.
 */

export interface TenantRentRequestRow {
  id: string;
  status: string | null;
  rent_amount: number | null;
  total_repayment: number | null;
  daily_repayment: number | null;
  duration_days: number | null;
  created_at: string;
  service_center_reviewed_at: string | null;
  coo_reviewed_at: string | null;
  approved_at: string | null;
  funded_at: string | null;
  disbursed_at: string | null;
  rejected_at: string | null;
}

export type StepState = 'done' | 'current' | 'upcoming' | 'stopped';

export interface ProgressStep {
  key: 'sent' | 'checking' | 'approval' | 'paid' | 'repaying';
  label: string;
  state: StepState;
  at: string | null;
}

export interface RentRequestProgress {
  /** in_progress: still moving; active: Rent Plan running or done; stopped: not going ahead. */
  phase: 'in_progress' | 'active' | 'stopped';
  headline: string;
  detail: string;
  steps: ProgressStep[];
}

const STEP_LABELS: Record<ProgressStep['key'], string> = {
  sent: 'Request sent',
  checking: 'Checking your details',
  approval: 'Final approval',
  paid: 'Rent paid to your landlord',
  repaying: 'Your Rent Plan',
};
const ORDER: ProgressStep['key'][] = ['sent', 'checking', 'approval', 'paid', 'repaying'];

/** Index of the step the request is on now (0-based), or -1 when everything is done. */
function currentIndex(status: string): number {
  switch (status) {
    case 'partner_ops_approved':
      return 2;
    case 'coo_approved':
      return 3;
    case 'funded':
    case 'repaying':
      return 4;
    case 'completed':
      return -1;
    default:
      // pending, service_center_review and anything unknown: being checked.
      return 1;
  }
}

const formatUGX = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;

export function describeRentRequestProgress(row: TenantRentRequestRow): RentRequestProgress {
  const status = (row.status ?? 'pending').toLowerCase();
  const stamps: Record<ProgressStep['key'], string | null> = {
    sent: row.created_at,
    checking: row.service_center_reviewed_at,
    approval: row.coo_reviewed_at ?? row.approved_at,
    paid: row.disbursed_at ?? row.funded_at,
    repaying: null,
  };

  if (status === 'rejected' || status === 'cancelled' || status === 'deleted_by_agent') {
    // Stopped while being checked: the first step is done, the second is where it stopped.
    const steps = ORDER.slice(0, 2).map((key, i) => ({
      key,
      label: i === 1 ? (status === 'rejected' ? 'Not approved' : 'Request closed') : STEP_LABELS[key],
      state: (i === 0 ? 'done' : 'stopped') as StepState,
      at: i === 0 ? stamps.sent : row.rejected_at,
    }));
    return {
      phase: 'stopped',
      headline: status === 'rejected' ? 'Your request was not approved' : 'This request was closed',
      detail: status === 'rejected'
        ? 'Talk to your agent or call Welile to find out why and what to fix before you ask again.'
        : 'It was withdrawn before approval. You can send a new request when you are ready.',
      steps,
    };
  }

  const cur = currentIndex(status);
  const steps: ProgressStep[] = ORDER.map((key, i) => ({
    key,
    label: STEP_LABELS[key],
    state: cur === -1 || i < cur ? 'done' : i === cur ? 'current' : 'upcoming',
    at: cur === -1 || i <= cur ? stamps[key] : null,
  }));

  const daily = row.daily_repayment ? formatUGX(row.daily_repayment) : null;
  switch (status) {
    case 'partner_ops_approved':
      return { phase: 'in_progress', headline: 'Almost approved', detail: 'Your details passed the checks. Your request is waiting for final approval.', steps };
    case 'coo_approved':
      return { phase: 'in_progress', headline: 'Approved — paying your landlord', detail: 'Welile is paying your rent to your landlord. Your Rent Plan starts the day after.', steps };
    case 'funded':
      return { phase: 'active', headline: 'Rent paid to your landlord', detail: daily ? `Your Rent Plan has started. Pay ${daily} a day.` : 'Your Rent Plan has started.', steps };
    case 'repaying':
      return { phase: 'active', headline: 'Your Rent Plan is running', detail: daily ? `Pay ${daily} a day. See your balance under Full Details.` : 'See your balance under Full Details.', steps };
    case 'completed':
      return { phase: 'active', headline: 'Rent Plan fully paid', detail: 'Well done. Paying on time raises the rent you can access next time.', steps };
    case 'pending':
      return { phase: 'in_progress', headline: 'Request received', detail: 'Welile will check your ID, your home, your landlord and your LC1. Your agent may call or visit you.', steps };
    default:
      return { phase: 'in_progress', headline: 'We are checking your details', detail: 'Welile is checking your ID, your home, your landlord and your LC1. Your agent may call or visit you.', steps };
  }
}

/** Whole days since the request was sent (0 on the day it was sent). */
export function daysSince(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}
