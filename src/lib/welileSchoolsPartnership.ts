/**
 * Welile Schools, phase 1 — school onboarding (partnership, term calendar, fees).
 *
 * The database is the authority: every write goes through a SECURITY DEFINER
 * function (welile_school_partnership_save / _term_save / _term_delete / _submit /
 * _review) that repeats these checks. The helpers here only give the agent the
 * same answers before they press Save, so a refusal is rare and explained.
 */
import { supabase } from '@/integrations/supabase/client';

// These tables are not in the generated Supabase types yet (Lovable regenerates them).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const PARTNERSHIP_DOCS_BUCKET = 'school-partnership-docs';

export type PartnershipStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected' | 'suspended';
export type PayoutMethod = 'bank' | 'mobile_money';
export type BoardingStatus = 'day' | 'boarding';
export type ReviewDecision = 'approve' | 'request_changes' | 'reject';

export interface PartnershipRow {
  id: string;
  school_id: string;
  agent_id: string;
  status: PartnershipStatus;
  bursar_name: string | null;
  bursar_phone: string | null;
  payout_method: PayoutMethod | null;
  payout_provider: string | null;
  payout_account_name: string | null;
  payout_account_number: string | null;
  agreement_path: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface TermRow {
  id: string;
  school_id: string;
  name: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;
  plan_due_date: string;
}

export interface FeeRow {
  id: string;
  term_id: string;
  class_name: string;
  boarding_status: BoardingStatus;
  amount: number;
}

export interface PartnershipDraft {
  bursar_name: string;
  bursar_phone: string;
  payout_method: PayoutMethod | '';
  payout_provider: string;
  payout_account_name: string;
  payout_account_number: string;
}

export interface FeeDraft {
  class_name: string;
  boarding_status: BoardingStatus;
  amount: string; // as typed; digits and separators allowed
}

export interface TermDraft {
  id: string | null;
  name: string;
  start_date: string;
  end_date: string;
  fees: FeeDraft[];
}

export const STATUS_LABEL: Record<PartnershipStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  changes_requested: 'Changes requested',
  approved: 'Approved partner',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

export const MOBILE_MONEY_PROVIDERS = ['MTN', 'Airtel'] as const;

/** Statuses in which the owning agent may still edit the set-up. */
export function isAgentEditable(status: PartnershipStatus | null | undefined): boolean {
  return status == null || status === 'draft' || status === 'changes_requested';
}

const DAY_MS = 86_400_000;

function parseIsoDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/** Plans are cleared two weeks before the term ends (mirrors the generated column). */
export function planDueDate(endDate: string): string | null {
  const t = parseIsoDate(endDate);
  if (t == null) return null;
  return new Date(t - 14 * DAY_MS).toISOString().slice(0, 10);
}

export function termLengthDays(startDate: string, endDate: string): number | null {
  const a = parseIsoDate(startDate);
  const b = parseIsoDate(endDate);
  if (a == null || b == null) return null;
  return Math.round((b - a) / DAY_MS);
}

/** "1,450,000" → 1450000; anything that is not a positive whole amount → null. */
export function parseAmount(raw: string): number | null {
  const digits = raw.replace(/[\s,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) return null;
  const n = Number(digits);
  return n > 0 && n <= 50_000_000 ? n : null;
}

export function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Field-level problems with the partnership details, empty when it can be saved. */
export function partnershipDraftErrors(d: PartnershipDraft): Partial<Record<keyof PartnershipDraft, string>> {
  const errors: Partial<Record<keyof PartnershipDraft, string>> = {};
  if (d.bursar_phone.trim() && (phoneDigits(d.bursar_phone).length < 9 || phoneDigits(d.bursar_phone).length > 13)) {
    errors.bursar_phone = 'Enter a valid phone number';
  }
  if (d.payout_method === 'mobile_money' && d.payout_account_number.trim()) {
    const n = phoneDigits(d.payout_account_number).length;
    if (n < 9 || n > 13) errors.payout_account_number = 'Enter the mobile money number';
  }
  return errors;
}

/** Everything a term needs before it can be saved; empty when valid. */
export function termDraftErrors(t: TermDraft): string[] {
  const errors: string[] = [];
  if (t.name.trim().length < 2) errors.push('Enter the term name');
  const days = termLengthDays(t.start_date, t.end_date);
  if (days == null) errors.push('Enter the term start and end dates');
  else if (days < 28) errors.push('A term must be at least 4 weeks long');
  else if (days > 200) errors.push('A term cannot be longer than 200 days');
  if (t.fees.length === 0) errors.push('Add at least one class fee');
  const seen = new Set<string>();
  t.fees.forEach((f, i) => {
    const label = f.class_name.trim() || `Fee ${i + 1}`;
    if (!f.class_name.trim()) errors.push(`Fee ${i + 1}: enter the class`);
    if (parseAmount(f.amount) == null) errors.push(`${label}: enter an amount above 0`);
    const key = `${f.class_name.trim().toLowerCase()}|${f.boarding_status}`;
    if (f.class_name.trim() && seen.has(key)) errors.push(`${label} (${f.boarding_status}) is listed twice`);
    seen.add(key);
  });
  return errors;
}

/** What still blocks "Submit for approval" — mirrors welile_school_partnership_submit. */
export function missingForSubmit(
  p: Pick<PartnershipRow, 'bursar_name' | 'bursar_phone' | 'payout_method' | 'payout_provider' | 'payout_account_name' | 'payout_account_number' | 'agreement_path'> | null,
  terms: TermRow[],
  fees: FeeRow[],
  today: string,
): string[] {
  const missing: string[] = [];
  if (!p?.bursar_name || !p?.bursar_phone) missing.push('bursar contact');
  if (!p?.payout_method || !p?.payout_provider || !p?.payout_account_name || !p?.payout_account_number) missing.push('school payout account');
  if (!p?.agreement_path) missing.push('signed partnership agreement');
  const termsWithFees = new Set(fees.map((f) => f.term_id));
  if (!terms.some((t) => t.end_date >= today && termsWithFees.has(t.id))) missing.push('a current or upcoming term with fees');
  return missing;
}

export function emptyTermDraft(): TermDraft {
  return { id: null, name: '', start_date: '', end_date: '', fees: [{ class_name: '', boarding_status: 'day', amount: '' }] };
}

export function termToDraft(term: TermRow, fees: FeeRow[]): TermDraft {
  return {
    id: term.id,
    name: term.name,
    start_date: term.start_date,
    end_date: term.end_date,
    fees: fees
      .filter((f) => f.term_id === term.id)
      .map((f) => ({ class_name: f.class_name, boarding_status: f.boarding_status, amount: String(Math.round(Number(f.amount))) })),
  };
}

export function todayKampala(): string {
  // Kampala is UTC+3 all year.
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** Turns a database refusal into words for the agent. */
export function partnershipErrorMessage(error: unknown): string {
  const raw = (error as { message?: string })?.message ?? String(error ?? '');
  if (raw.includes('PARTNERSHIP_LOCKED')) return 'This partnership is locked while it is with ops. Ask ops to send it back for changes.';
  if (raw.includes('NOT_AUTHORIZED')) return 'You do not have permission to do this.';
  if (raw.includes('AUTH_REQUIRED')) return 'Sign in again and retry.';
  if (raw.includes('unique') || raw.includes('already exists')) return 'A term with this name, or a duplicate class fee, already exists.';
  return raw.replace(/^.*?ERROR:\s*/, '') || 'Something went wrong. Try again.';
}

// ─── Data access ─────────────────────────────────────────────────────────────

export async function fetchSchoolSetup(schoolId: string) {
  const [{ data: partnership, error: e1 }, { data: terms, error: e2 }] = await Promise.all([
    db.from('welile_school_partnerships').select('*').eq('school_id', schoolId).maybeSingle(),
    db.from('welile_school_terms').select('*').eq('school_id', schoolId).order('start_date', { ascending: true }),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const termIds = ((terms ?? []) as TermRow[]).map((t) => t.id);
  let fees: FeeRow[] = [];
  if (termIds.length) {
    const { data, error } = await db.from('welile_school_fee_structures').select('*').in('term_id', termIds).order('class_name');
    if (error) throw error;
    fees = (data ?? []) as FeeRow[];
  }
  return { partnership: (partnership ?? null) as PartnershipRow | null, terms: (terms ?? []) as TermRow[], fees };
}

export async function savePartnership(schoolId: string, d: PartnershipDraft, agreementPath: string | null) {
  const { data, error } = await db.rpc('welile_school_partnership_save', {
    p_school_id: schoolId,
    p_bursar_name: d.bursar_name,
    p_bursar_phone: d.bursar_phone,
    p_payout_method: d.payout_method || null,
    p_payout_provider: d.payout_provider,
    p_payout_account_name: d.payout_account_name,
    p_payout_account_number: d.payout_account_number,
    p_agreement_path: agreementPath,
  });
  if (error) throw error;
  return data as PartnershipRow;
}

export async function saveTerm(schoolId: string, t: TermDraft) {
  const { data, error } = await db.rpc('welile_school_term_save', {
    p_school_id: schoolId,
    p_term_id: t.id,
    p_name: t.name.trim(),
    p_start_date: t.start_date,
    p_end_date: t.end_date,
    p_fees: t.fees.map((f) => ({ class_name: f.class_name.trim(), boarding_status: f.boarding_status, amount: parseAmount(f.amount) })),
  });
  if (error) throw error;
  return data as string;
}

export async function deleteTerm(termId: string) {
  const { error } = await db.rpc('welile_school_term_delete', { p_term_id: termId });
  if (error) throw error;
}

export async function submitPartnership(schoolId: string) {
  const { data, error } = await db.rpc('welile_school_partnership_submit', { p_school_id: schoolId });
  if (error) throw error;
  return data as PartnershipRow;
}

export async function reviewPartnership(partnershipId: string, decision: ReviewDecision, note: string) {
  const { data, error } = await db.rpc('welile_school_partnership_review', {
    p_partnership_id: partnershipId,
    p_decision: decision,
    p_note: note || null,
  });
  if (error) throw error;
  return data as PartnershipRow;
}

/** Uploads the signed agreement to <school_id>/agreement-<time>.<ext> and returns its path. */
export async function uploadAgreement(schoolId: string, file: File): Promise<string> {
  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
  const path = `${schoolId}/agreement-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(PARTNERSHIP_DOCS_BUCKET).upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw error;
  return path;
}

export async function agreementUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(PARTNERSHIP_DOCS_BUCKET).createSignedUrl(path, 600);
  if (error) return null;
  return data?.signedUrl ?? null;
}
