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

/**
 * The three questions staff ask on an awareness call, worded exactly as the plan asks. The amount is the fixed programme
 * figure, written out as "UGX 30,000,000" rather than run through formatUGX, which follows the viewer's chosen currency
 * and could print it converted.
 */
export const QUESTION_30M_ACCESS =
  'Does this person know that a tenant who pays well can grow their access up to UGX 30,000,000?';
export const QUESTION_SELF_PAYMENT =
  'Does this person know they can pay by themselves using the Welile merchant codes (self-payment)?';
export const QUESTION_EXPLAINED = 'Did you explain it to them on this call?';

/** Short names for the same answers, used on cards, charts, tables, filters and exports. */
export const LABEL_30M_ACCESS = 'Knew about 30M access';
export const LABEL_SELF_PAYMENT = 'Knew about merchant-code self-payment';
export const LABEL_EXPLAINED = 'Explained on the call';

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

/**
 * Stages that see the awareness calls but are not expected to phone anyone: the COO approval (partner_ops_approved) and the CFO
 * payout (coo_approved). They show the earlier stages' answers read-only, with no call buttons and no reminder.
 */
export function isAwarenessReadOnlyStage(stage: string | null | undefined): boolean {
  return stage === 'partner_ops_approved' || stage === 'coo_approved';
}

/** True when the reports refused the person (they are not allowed to use the log), as opposed to a failed load. */
export function isNotAuthorizedError(error: unknown): boolean {
  const message = (error as { message?: string } | null | undefined)?.message ?? '';
  return /not authori[sz]ed/i.test(message);
}

/** Who a call button reaches, in the words on the button. */
export const CALL_BUTTON_LABEL: Record<AwarenessSubject, string> = {
  tenant: 'Call tenant',
  landlord: 'Call landlord',
  agent: 'Call agent',
};

