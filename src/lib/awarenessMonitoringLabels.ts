/**
 * Labels and small helpers for the Tenant Ops "Awareness Calls" monitoring page. The answer values are the ones the awareness
 * call log stores (and the 30M awareness record already uses): knew / heard / did_not_know and yes / partly / no.
 */
import {
  AWARENESS_OPTIONS, EXPLAINED_OPTIONS, stageLabel,
  type AwarenessCallResult, type AwarenessChoice, type ExplainedChoice,
} from '@/lib/awarenessCallLabels';

export type AnswerField = 'aware_30m' | 'aware_merchant_codes' | 'explained';

/** One entry of the "answer choice" filter: a question and one of its answers. */
export interface AnswerFilterOption { value: string; label: string; field: AnswerField; answer: AwarenessChoice | ExplainedChoice }

const optionsFor = (field: AnswerField, prefix: string, options: { value: string; label: string }[]): AnswerFilterOption[] =>
  options.map((o) => ({
    value: `${field}:${o.value}`,
    label: `${prefix}: ${o.label}`,
    field,
    answer: o.value as AwarenessChoice | ExplainedChoice,
  }));

export const ANSWER_FILTER_OPTIONS: AnswerFilterOption[] = [
  ...optionsFor('aware_30m', 'Knew about 30M', AWARENESS_OPTIONS),
  ...optionsFor('aware_merchant_codes', 'Knew merchant codes', AWARENESS_OPTIONS),
  ...optionsFor('explained', 'Explained', EXPLAINED_OPTIONS),
];

export function splitAnswerFilter(value: string | null | undefined): { field: AnswerField; answer: string } | null {
  if (!value) return null;
  const hit = ANSWER_FILTER_OPTIONS.find((o) => o.value === value);
  return hit ? { field: hit.field, answer: hit.answer } : null;
}

export const SUBJECT_FILTER_OPTIONS = [
  { value: 'tenant', label: 'Tenant' },
  { value: 'landlord', label: 'Landlord' },
  { value: 'agent', label: 'Agent' },
] as const;

export const RESULT_FILTER_OPTIONS: { value: AwarenessCallResult; label: string }[] = [
  { value: 'answered', label: 'Answered' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'phone_off', label: 'Phone off' },
  { value: 'wrong_number', label: 'Wrong number' },
];

/** The status of a Rent Plan now, in plain words ("service_center_review" -> "Service centre review"). */
export const statusLabel = stageLabel;

const KAMPALA = 'Africa/Kampala';

/** "07 Oct, 14:32" in Kampala time, whatever the device's timezone. */
export function kampalaDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: KAMPALA, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');
}

/** "07 Oct 2026" for a Kampala calendar day (YYYY-MM-DD) or an instant. */
export function kampalaDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: KAMPALA, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

/** Whole-number text with thousands separators; "—" when missing. */
export const count = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
export const percent = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(1)}%`);
