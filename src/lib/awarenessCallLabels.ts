/**
 * Plain-language labels for the rent pipeline "awareness call" feedback (rent_pipeline_awareness_calls).
 * The answer values are the same as the 30M awareness record already in use (tops_30m_awareness and
 * awareness30m in callingCenterWeeklyForwardingPdf.ts): knew / heard / did_not_know and yes / partly / no.
 */

export type AwarenessSubject = 'tenant' | 'landlord' | 'agent';
export type AwarenessCallResult = 'answered' | 'no_answer' | 'phone_off' | 'wrong_number';
export type AwarenessChoice = 'knew' | 'heard' | 'did_not_know';
export type ExplainedChoice = 'yes' | 'partly' | 'no';
export type AwarenessTeam = 'service_centre' | 'agent_ops' | 'tenant_ops' | 'landlord_ops' | 'other';

export const CALL_RESULT_OPTIONS: { value: AwarenessCallResult; label: string }[] = [
  { value: 'answered', label: 'Answered' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'phone_off', label: 'Phone off' },
  { value: 'wrong_number', label: 'Wrong number' },
];

/** Same wording as the weekly forwarding report. */
export const AWARENESS_OPTIONS: { value: AwarenessChoice; label: string }[] = [
  { value: 'knew', label: 'Knew about it' },
  { value: 'heard', label: 'Heard but unsure' },
  { value: 'did_not_know', label: 'Did not know' },
];

export const EXPLAINED_OPTIONS: { value: ExplainedChoice; label: string }[] = [
  { value: 'yes', label: 'Yes, fully explained' },
  { value: 'partly', label: 'Partly explained' },
  { value: 'no', label: 'Not explained' },
];

export const TEAM_LABEL: Record<AwarenessTeam, string> = {
  service_centre: 'Service centre',
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  other: 'Other teams',
};

/** The order teams are listed in, following the Rent Plan's path through the pipeline. */
export const TEAM_ORDER: AwarenessTeam[] = ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'other'];

export const SUBJECT_LABEL: Record<AwarenessSubject, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  agent: 'Agent',
};

const lookup = <T extends string>(options: { value: T; label: string }[], value: string | null | undefined) =>
  options.find((o) => o.value === value)?.label ?? (value ?? '');

export const callResultLabel = (v: string | null | undefined) => lookup(CALL_RESULT_OPTIONS, v);
export const awarenessLabel = (v: string | null | undefined) => lookup(AWARENESS_OPTIONS, v);
export const explainedLabel = (v: string | null | undefined) => lookup(EXPLAINED_OPTIONS, v);

/** "service_center_review" -> "Service centre review". */
export function stageLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown stage';
  const text = status.replace(/_/g, ' ').replace(/center/g, 'centre');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The number to hand to a tel: link: digits and a leading plus only. */
export function telHref(phone: string | null | undefined): string | null {
  const cleaned = (phone ?? '').replace(/[^\d+]/g, '');
  return cleaned.replace(/\D/g, '').length >= 7 ? `tel:${cleaned}` : null;
}

/**
 * Who a review stage usually phones first. The rent pipeline queue is named by the status of the requests in it:
 * 'tenant_ops_approved' is the Landlord Ops review, so Landlord Ops starts with the landlord. Agent Ops ('pending'),
 * Tenant Ops ('agent_ops_approved'), the service centre and every other stage start with the tenant.
 */
export function defaultAwarenessSubjectForStage(stage: string | null | undefined): 'tenant' | 'landlord' {
  return stage === 'tenant_ops_approved' ? 'landlord' : 'tenant';
}
