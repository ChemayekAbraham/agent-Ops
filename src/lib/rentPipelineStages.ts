/**
 * Shared, human-readable mapping of the rent request pipeline so the Service
 * Center manager can follow a tenant from their own verification all the way
 * to funded and repaying. Order mirrors the rent_requests status constraint.
 */
export const RENT_PIPELINE_STAGES = [
  { key: 'pending', label: 'Submitted' },
  { key: 'service_center_review', label: 'Service Center check' },
  { key: 'agent_ops_approved', label: 'Agent operations' },
  { key: 'tenant_ops_approved', label: 'Tenant operations' },
  { key: 'landlord_ops_approved', label: 'Landlord operations' },
  { key: 'partner_ops_approved', label: 'Partner operations' },
  { key: 'coo_approved', label: 'Executive approval' },
  { key: 'funded', label: 'Funded' },
  { key: 'repaying', label: 'Repaying' },
  { key: 'completed', label: 'Completed' },
] as const;

export type RentPipelineStageKey = (typeof RENT_PIPELINE_STAGES)[number]['key'];

/** Statuses that end the journey instead of advancing it. */
export const RENT_PIPELINE_TERMINAL: Record<string, string> = {
  rejected: 'Declined',
  cancelled: 'Cancelled',
  defaulted: 'Defaulted',
  deleted_by_agent: 'Withdrawn by agent',
};

const ALIASES: Record<string, RentPipelineStageKey> = {
  approved: 'coo_approved',
  agent_verified: 'agent_ops_approved',
  disbursed: 'funded',
  fully_repaid: 'completed',
};

export function pipelineStageKey(status: string): RentPipelineStageKey | null {
  if (RENT_PIPELINE_TERMINAL[status]) return null;
  const alias = ALIASES[status];
  if (alias) return alias;
  return RENT_PIPELINE_STAGES.some((s) => s.key === status)
    ? (status as RentPipelineStageKey)
    : null;
}

/** Zero-based index of the stage a request currently sits at, or -1 if terminal. */
export function pipelineStageIndex(status: string): number {
  const key = pipelineStageKey(status);
  if (!key) return -1;
  return RENT_PIPELINE_STAGES.findIndex((s) => s.key === key);
}

export function pipelineStageLabel(status: string): string {
  if (RENT_PIPELINE_TERMINAL[status]) return RENT_PIPELINE_TERMINAL[status];
  const key = pipelineStageKey(status);
  const stage = RENT_PIPELINE_STAGES.find((s) => s.key === key);
  return stage?.label ?? status.replace(/_/g, ' ');
}

/** Every status the follow-up filter offers, in pipeline order then terminals. */
export const RENT_STATUS_FILTERS: { key: string; label: string }[] = [
  ...RENT_PIPELINE_STAGES.map((s) => ({ key: s.key, label: s.label })),
  ...Object.entries(RENT_PIPELINE_TERMINAL)
    .filter(([k]) => k !== 'deleted_by_agent')
    .map(([key, label]) => ({ key, label })),
];