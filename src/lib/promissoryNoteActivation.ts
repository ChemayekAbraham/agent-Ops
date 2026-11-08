// Promissory-note activation page (src/pages/ActivatePartner.tsx): reading the lookup and activation
// answers. The database decides every rate (lookup_promissory_note / activate_promissory_note, design
// v2 §2.1 #3-#4, §3.4); this only reads them. A rate the viewer may not see arrives as null and stays
// null (no number shown, never a fallback rate).
import { monthlyReturnFor, rateOrNull } from './partnerReturnPolicy';

const numOrNull = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** The note's own rate and monthly Returns as the lookup returned them; null = hidden. */
export function noteReturnFigures(note: { return_rate?: unknown; monthly_return?: unknown; amount?: unknown } | null | undefined): {
  rate: number | null;
  monthlyReturn: number | null;
} {
  const rate = rateOrNull(note?.return_rate);
  if (rate === null) return { rate: null, monthlyReturn: null };
  // The database computes monthly_return from the note's own stored rate; computing it here from the
  // same stored rate gives the same figure when an older lookup leaves it out.
  return { rate, monthlyReturn: numOrNull(note?.monthly_return) ?? monthlyReturnFor(note?.amount, rate) };
}

export interface ActivationResult {
  alreadyActive: boolean;
  /** The note's rate and monthly Returns (the caller's own note, so visible); null when absent. */
  returnRate: number | null;
  monthlyReturn: number | null;
  /** What a deposit opens at for the caller (their own rate for a new portfolio); null when unknown. */
  yourRate: number | null;
}

/** The activate-promissory-note success body (old function: only success/already_active). */
export function parseActivationResult(data: unknown): ActivationResult {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const note = noteReturnFigures({ return_rate: d.return_rate, monthly_return: d.monthly_return, amount: d.amount });
  return {
    alreadyActive: d.already_active === true,
    returnRate: note.rate,
    monthlyReturn: note.monthlyReturn,
    yourRate: rateOrNull(d.your_rate),
  };
}

export type ActivationErrorKind =
  | 'sign_in'            // 401: no or expired session
  | 'linked_elsewhere'   // 403: the note belongs to another account
  | 'contact_mismatch'   // 403: pre-cut-off note, caller's verified contacts do not match (D3): Partner Ops links it
  | 'changed'            // 409: the note changed while activating: open the link again
  | 'not_open'           // 400: the note is no longer pending/activated
  | 'not_found'          // 404
  | 'failed';            // anything else

export interface ActivationError {
  status: number | null;
  kind: ActivationErrorKind;
  /** The function's own message when it sent one, else a plain default. */
  message: string;
}

const DEFAULT_MESSAGES: Record<ActivationErrorKind, string> = {
  sign_in: 'Please sign in to activate this note',
  linked_elsewhere: 'This note is already linked to another account',
  contact_mismatch: 'This note was written for another phone number or email. Partner Ops can link it for you.',
  changed: 'This note changed while you were activating it. Please open the link again.',
  not_open: 'This note can no longer be activated',
  not_found: 'This activation link is invalid or has expired',
  failed: 'Activation failed. Please try again.',
};

/** Map the function's HTTP status and JSON body to what the page shows (design v2 §3.4.1 mapError). */
export function activationErrorFrom(status: number | null, body: unknown): ActivationError {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).error : null;
  const msg = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  // The new function sends a `code` with each refusal (mapError); the old one sends only `error`.
  const rawCode = body && typeof body === 'object' ? (body as Record<string, unknown>).code : null;
  const code = typeof rawCode === 'string' ? rawCode : null;
  let kind: ActivationErrorKind;
  if (status === 401) kind = 'sign_in';
  else if (status === 403) {
    kind = code === 'NOTE_CONTACT_MISMATCH' ? 'contact_mismatch'
      : code === 'NOTE_LINKED_ELSEWHERE' ? 'linked_elsewhere'
      : msg && /another phone number|Partner Ops/i.test(msg) ? 'contact_mismatch' : 'linked_elsewhere';
  }
  else if (status === 409) kind = 'changed';
  else if (status === 404) kind = 'not_found';
  else if (status === 400) kind = 'not_open';
  else kind = 'failed';
  // A 5xx body or a transport error never reaches the page as raw text. A contact mismatch always says
  // that Partner Ops can link the note (the person's only way forward), whatever the server's wording.
  const useServerText = msg !== null && kind !== 'failed' && kind !== 'contact_mismatch';
  return { status, kind, message: useServerText ? msg : DEFAULT_MESSAGES[kind] };
}
