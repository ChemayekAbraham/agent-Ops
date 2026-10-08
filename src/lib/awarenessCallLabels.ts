/**
 * Plain-language labels for the rent pipeline "awareness call" feedback (rent_pipeline_awareness_calls).
 * The answer values are the same as the 30M awareness record already in use (tops_30m_awareness and
 * awareness30m in callingCenterWeeklyForwardingPdf.ts): knew / heard / did_not_know and yes / partly / no.
 */

export type AwarenessSubject = 'tenant' | 'landlord' | 'agent';
export type AwarenessCallResult = 'answered' | 'no_answer' | 'phone_off' | 'wrong_number';
export type AwarenessChoice = 'knew' | 'heard' | 'did_not_know';
export type ExplainedChoice = 'yes' | 'partly' | 'no';
export type LandlordConsent = 'consents' | 'unsure' | 'refuses';
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

/**
 * A LANDLORD is asked two different questions instead of the merchant-code one: whether they consent to receive the tenant's rent
 * through Welile, and whether they know about the payment code (OTP) they will get when they are paid. Tenants and agents keep the
 * three questions above, unchanged.
 */
export const QUESTION_LANDLORD_CONSENT = "Does the landlord consent to receive this tenant's rent through Welile?";
export const QUESTION_PAYOUT_OTP =
  'Does the landlord know about the payment code (OTP)? When they are paid, Welile sends an SMS from WELILE with a 6-digit code valid for 1 hour, to share only with the agent paying them.';
export const LABEL_LANDLORD_CONSENT = 'Landlord consent';
export const LABEL_PAYOUT_OTP = 'Knew about payment code (OTP)';

/** A short script the caller can read aloud to the landlord. */
export const LANDLORD_READ_ALOUD =
  'Hello, I am calling from Welile about the rent for your tenant. Welile will pay the rent to you directly, and we would like to confirm that you agree to receive it this way. When we pay you, you will get an SMS from WELILE with a 6-digit code that is valid for 1 hour. Please share that code only with the agent who is paying you, and with no one else.';

/** What an older landlord call shows for a question it was not asked, or for the old merchant-code question. */
export const OLD_QUESTION_LABEL = 'Old question';
export const NOT_ASKED_LABEL = 'Not asked';

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

export const CONSENT_OPTIONS: { value: LandlordConsent; label: string }[] = [
  { value: 'consents', label: 'Consents' },
  { value: 'unsure', label: 'Not sure, wants to think' },
  { value: 'refuses', label: 'Does not consent' },
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
export const consentLabel = (v: string | null | undefined) => lookup(CONSENT_OPTIONS, v);

/** The answer fields of one call, as the log stores them. */
export interface CallAnswerFields {
  subject_type: AwarenessSubject;
  call_result: AwarenessCallResult;
  aware_30m: string | null;
  aware_merchant_codes: string | null;
  landlord_consent?: string | null;
  aware_payout_otp?: string | null;
  explained: string | null;
}

/**
 * Which questions a call was asked, so every screen reads a call the same way:
 *  - tenant or agent: 30M access, merchant-code self-payment, explained (unchanged);
 *  - landlord (new questions): 30M access, consent, payment code (OTP), explained;
 *  - landlord recorded before the change (it has a merchant-code answer and no consent): the merchant-code question reads "Old question"
 *    and the two new questions read "Not asked".
 * A call that was not answered has no answers.
 */
export type AnswerShape = 'none' | 'tenant_agent' | 'landlord' | 'landlord_old';
export function answerShape(c: Pick<CallAnswerFields, 'subject_type' | 'call_result' | 'landlord_consent' | 'aware_merchant_codes'>): AnswerShape {
  if (c.call_result !== 'answered') return 'none';
  if (c.subject_type !== 'landlord') return 'tenant_agent';
  return c.landlord_consent ? 'landlord' : 'landlord_old';
}

export interface AnswerRow { key: 'aware_30m' | 'self_payment' | 'consent' | 'payout_otp' | 'explained'; label: string; value: string; destructive?: boolean }

export function answerRowsForCall(c: CallAnswerFields): AnswerRow[] {
  const shape = answerShape(c);
  if (shape === 'none') return [];
  const rows: AnswerRow[] = [{ key: 'aware_30m', label: LABEL_30M_ACCESS, value: awarenessLabel(c.aware_30m) }];
  if (shape === 'tenant_agent') {
    rows.push({ key: 'self_payment', label: LABEL_SELF_PAYMENT, value: awarenessLabel(c.aware_merchant_codes) });
  } else if (shape === 'landlord') {
    rows.push({ key: 'consent', label: LABEL_LANDLORD_CONSENT, value: consentLabel(c.landlord_consent), destructive: c.landlord_consent === 'refuses' });
    rows.push({ key: 'payout_otp', label: LABEL_PAYOUT_OTP, value: awarenessLabel(c.aware_payout_otp) });
  } else {
    rows.push({ key: 'self_payment', label: LABEL_SELF_PAYMENT, value: OLD_QUESTION_LABEL });
    rows.push({ key: 'consent', label: LABEL_LANDLORD_CONSENT, value: NOT_ASKED_LABEL });
    rows.push({ key: 'payout_otp', label: LABEL_PAYOUT_OTP, value: NOT_ASKED_LABEL });
  }
  rows.push({ key: 'explained', label: LABEL_EXPLAINED, value: explainedLabel(c.explained) });
  return rows;
}

/** The answers as one line, "30M access: Knew about it · Self-payment: ...", for tables. */
export function answersLine(c: CallAnswerFields): string {
  const rows = answerRowsForCall(c);
  return rows.length === 0 ? '—' : rows.map((r) => `${r.label}: ${r.value}`).join(' · ');
}

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

