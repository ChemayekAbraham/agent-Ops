/**
 * Intake details an agent must give for every rent request: family size, the
 * tenant's work or business, and the LC1 letter (or a reason it is missing).
 *
 * The rules live here so the rent request assistant and the agent home's
 * "Complete your requests" card check the same things. Saving goes through
 * three RPCs; the frontend never writes these rows itself.
 *   - agent_save_intake_details(p_request_id, p_family_size, p_work_business, p_work_location)
 *   - agent_attach_lc1_letter(p_request_id, p_path)
 *   - agent_note_lc1_missing(p_request_id, p_reason)  (the "No LC1 letter yet" reason)
 *   - agent_requests_missing_details() → { rows: [...] }
 */
import { supabase } from '@/integrations/supabase/client';

export const FAMILY_SIZE_MIN = 1;
export const FAMILY_SIZE_MAX = 30;
export const WORK_MIN_CHARS = 3;
export const NO_LC1_REASON_MIN_CHARS = 10;

/** Parses a typed family size; null when it is not a whole number. */
export function parseFamilySize(text: string): number | null {
  const t = String(text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  return parseInt(t, 10);
}

export function familySizeProblem(text: string): string | null {
  const n = parseFamilySize(text);
  if (n === null) return 'Type how many people live in the household, as a number like 4.';
  if (n < FAMILY_SIZE_MIN || n > FAMILY_SIZE_MAX) return `Family size must be between ${FAMILY_SIZE_MIN} and ${FAMILY_SIZE_MAX}.`;
  return null;
}

export function workProblem(text: string): string | null {
  return String(text ?? '').trim().length >= WORK_MIN_CHARS
    ? null
    : `Type the tenant’s work or business (at least ${WORK_MIN_CHARS} letters), like “Boda boda rider”.`;
}

export interface Lc1LetterAnswer {
  hasLetter: boolean;
  noLetterYet: boolean;
  reason: string;
}

export function lc1LetterProblem({ hasLetter, noLetterYet, reason }: Lc1LetterAnswer): string | null {
  if (hasLetter) return null;
  if (!noLetterYet) return 'Add a photo of the LC1 letter, or tick “No LC1 letter yet” and say why.';
  return reason.trim().length >= NO_LC1_REASON_MIN_CHARS
    ? null
    : `Say why there’s no LC1 letter yet (at least ${NO_LC1_REASON_MIN_CHARS} characters).`;
}

/** The tenant's name as on the ID needs at least two names. */
export function isFullName(name: string | null | undefined): boolean {
  return String(name ?? '').trim().split(/\s+/).filter(Boolean).length >= 2;
}

export const ASK_FULL_NAME = 'Ask the tenant for their full name';

type RpcResult = { data: unknown; error: { message?: string } | null };
type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;
/** These RPCs are newer than the generated types. */
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

/** Flat on purpose: the app's tsconfig is not strict, so a discriminated union would not narrow. */
export type SaveOutcome = { ok: boolean; message: string | null };

function outcome(error: { message?: string } | null): SaveOutcome {
  if (!error) return { ok: true, message: null };
  return { ok: false, message: error.message || 'The server did not accept the details.' };
}

/** A null field is one the agent was not asked for (it is already on file). */
export interface IntakeDetails {
  familySize: number | null;
  workBusiness: string | null;
  workLocation?: string | null;
}

export async function saveIntakeDetails(requestId: string, d: IntakeDetails): Promise<SaveOutcome> {
  const location = (d.workLocation ?? '').trim();
  try {
    const { error } = await rpc('agent_save_intake_details', {
      p_request_id: requestId,
      p_family_size: d.familySize,
      p_work_business: d.workBusiness == null ? null : d.workBusiness.trim(),
      p_work_location: location || null,
    });
    return outcome(error);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function attachLc1Letter(requestId: string, path: string): Promise<SaveOutcome> {
  try {
    const { error } = await rpc('agent_attach_lc1_letter', { p_request_id: requestId, p_path: path });
    return outcome(error);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Records why there is no LC1 letter yet; the Service Centre then calls the LC1. */
export async function noteLc1Missing(requestId: string, reason: string): Promise<SaveOutcome> {
  try {
    const { error } = await rpc('agent_note_lc1_missing', { p_request_id: requestId, p_reason: reason.trim() });
    return outcome(error);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export type MissingItem = 'family_size' | 'work_business' | 'lc1_letter' | 'tenant_full_name';
const MISSING_ITEMS: MissingItem[] = ['family_size', 'work_business', 'lc1_letter', 'tenant_full_name'];

export interface RequestMissingDetails {
  id: string;
  req: string | null;
  tenant: string | null;
  status: string | null;
  submitted_at: string | null;
  rent: number | null;
  missing: MissingItem[];
}

/** Keeps known missing items only; drops rows with nothing left to complete. */
export function normalizeMissingRows(data: unknown): RequestMissingDetails[] {
  const raw = (data && typeof data === 'object' && Array.isArray((data as { rows?: unknown }).rows))
    ? (data as { rows: unknown[] }).rows
    : [];
  const out: RequestMissingDetails[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== 'string') continue;
    const missing = (Array.isArray(row.missing) ? row.missing : [])
      .filter((m): m is MissingItem => MISSING_ITEMS.includes(m as MissingItem));
    if (missing.length === 0) continue;
    const rent = row.rent == null ? null : Number(row.rent);
    out.push({
      id: row.id,
      req: row.req == null ? null : String(row.req),
      tenant: row.tenant == null ? null : String(row.tenant),
      status: row.status == null ? null : String(row.status),
      submitted_at: row.submitted_at == null ? null : String(row.submitted_at),
      rent: rent != null && Number.isFinite(rent) ? rent : null,
      missing,
    });
  }
  return out;
}

export async function fetchRequestsMissingDetails(): Promise<RequestMissingDetails[]> {
  const { data, error } = await rpc('agent_requests_missing_details');
  if (error) throw new Error(error.message || 'Could not load requests missing details');
  return normalizeMissingRows(data);
}
