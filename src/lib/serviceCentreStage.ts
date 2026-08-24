/**
 * Single source of truth for "where in the pipeline is this service centre, and
 * which dashboard is it sitting on right now?"
 *
 * Pipeline (public.service_centre_setups):
 *   pending                        -> Agent Ops verification queue
 *   verified                       -> COO vetting
 *   active + no cfo_decision       -> CFO spend approval
 *   active/paid + cfo approved     -> Funded (money released)
 *   rejected / cfo declined        -> stopped
 */

export type ServiceCentreStageKey = 'agent_ops' | 'coo' | 'cfo' | 'funded';

export interface ServiceCentreStageStep {
  key: ServiceCentreStageKey;
  /** Dashboard that owns this step. */
  dashboard: string;
  /** What happens on that dashboard. */
  action: string;
  state: 'done' | 'current' | 'upcoming' | 'stopped';
}

export interface ServiceCentreStageInfo {
  steps: ServiceCentreStageStep[];
  /** Human sentence for the badge, e.g. "Pending on COO dashboard". */
  label: string;
  isFunded: boolean;
  isStopped: boolean;
  stoppedReason: string | null;
  fundedAmount: number | null;
  fundedAt: string | null;
  fundedPayee: string | null;
}

interface SetupLike {
  status?: string | null;
  cfo_decision?: string | null;
  cfo_decided_at?: string | null;
  cfo_approved_amount?: number | string | null;
  verified_amount?: number | string | null;
  payee_name?: string | null;
  rejection_reason?: string | null;
  ceo_rejection_reason?: string | null;
  cfo_comment?: string | null;
}

const ORDER: Array<{ key: ServiceCentreStageKey; dashboard: string; action: string }> = [
  { key: 'agent_ops', dashboard: 'Agent Ops', action: 'Verify photo, amount & comment' },
  { key: 'coo', dashboard: 'COO', action: 'Vet & activate the centre' },
  { key: 'cfo', dashboard: 'CFO', action: 'Approve the spend & recipient' },
  { key: 'funded', dashboard: 'Funded', action: 'Money released to the recipient' },
];

function toNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getServiceCentreStage(setup: SetupLike): ServiceCentreStageInfo {
  const status = (setup.status || '').toLowerCase();
  const decision = (setup.cfo_decision || '').toLowerCase();

  const cfoApproved = decision === 'approved';
  const cfoDeclined = decision === 'declined' || decision === 'rejected';
  const isFunded = cfoApproved || status === 'paid';
  const isStopped = status === 'rejected' || cfoDeclined;

  // Index of the step that still owes an action (or the funded step once done).
  let currentIndex: number;
  if (isFunded) currentIndex = 3;
  else if (status === 'active') currentIndex = 2;
  else if (status === 'verified') currentIndex = 1;
  else currentIndex = 0;

  const steps: ServiceCentreStageStep[] = ORDER.map((s, i) => ({
    ...s,
    state:
      isStopped && i === currentIndex
        ? 'stopped'
        : i < currentIndex
          ? 'done'
          : i === currentIndex
            ? isFunded
              ? 'done'
              : 'current'
            : 'upcoming',
  }));

  const stoppedReason =
    setup.rejection_reason?.trim() ||
    setup.ceo_rejection_reason?.trim() ||
    (cfoDeclined ? setup.cfo_comment?.trim() || 'Declined by CFO' : null) ||
    null;

  const label = isFunded
    ? 'Funded — money released'
    : isStopped
      ? `Stopped on ${ORDER[currentIndex].dashboard} dashboard`
      : `Pending on ${ORDER[currentIndex].dashboard} dashboard`;

  return {
    steps,
    label,
    isFunded,
    isStopped,
    stoppedReason: isStopped ? stoppedReason : null,
    fundedAmount: isFunded
      ? toNumber(setup.cfo_approved_amount) ?? toNumber(setup.verified_amount)
      : null,
    fundedAt: isFunded ? setup.cfo_decided_at ?? null : null,
    fundedPayee: isFunded ? setup.payee_name?.trim() || null : null,
  };
}
