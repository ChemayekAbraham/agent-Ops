/**
 * The E124 intake calls: who may post (become_agent), the step-1 tenant check
 * (intake_tenant_check), the face-check record (face_check_record) and what a returned
 * request must fix (return_items_for). The live functions are not in the generated types
 * when this was written, so replies are read tolerantly: a code may come as status / result / code / kind,
 * an id as request_id / rent_request_id / id. Nothing here throws.
 */
import { supabase } from '@/integrations/supabase/client';

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

const obj = (raw: unknown): Record<string, unknown> | null => {
  let r: unknown = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return { status: r }; } }
  if (Array.isArray(r)) r = r[0];
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null);
const codeOf = (o: Record<string, unknown> | null): string => (
  str(o?.status) ?? str(o?.result) ?? str(o?.code) ?? str(o?.kind) ?? str(o?.outcome) ?? str(o?.error) ?? ''
).toLowerCase();

// ----- step 1: the tenant's phone -----
export type IntakeTenantCheck =
  | { kind: 'ok' }
  | { kind: 'own_phone'; message: string | null }
  | { kind: 'open_request'; mine: boolean; requestId: string | null; stage: string | null; status: string | null; message: string | null }
  | { kind: 'returned_request'; mine: boolean; requestId: string | null; message: string | null }
  | { kind: 'unavailable'; message: string | null };

export function parseIntakeTenantCheck(raw: unknown, me?: string | null): IntakeTenantCheck {
  const o = obj(raw);
  const code = codeOf(o);
  const message = str(o?.message) ?? str(o?.reason) ?? null;
  const requestId = str(o?.request_id) ?? str(o?.rent_request_id) ?? str(o?.id) ?? null;
  const mine = bool(o?.mine) ?? bool(o?.is_mine) ?? bool(o?.yours) ?? (me && str(o?.agent_id) ? str(o?.agent_id) === me : false) ?? false;
  if (code.includes('own_phone') || bool(o?.own_phone) === true) return { kind: 'own_phone', message };
  if (code.includes('returned')) return { kind: 'returned_request', mine: !!mine, requestId, message };
  if (code.includes('open')) {
    return {
      kind: 'open_request', mine: !!mine, requestId, message,
      stage: str(o?.stage_label) ?? str(o?.desk) ?? str(o?.where) ?? str(o?.stage) ?? null,
      status: str(o?.request_status) ?? str(o?.rent_status) ?? null,
    };
  }
  return { kind: 'ok' };
}

/** intake_tenant_check for the tenant's phone; 'unavailable' when it could not be read. */
export async function checkIntakeTenant(phone: string, me?: string | null): Promise<IntakeTenantCheck> {
  try {
    const { data, error } = await rpc('intake_tenant_check', { p_tenant_phone: phone.replace(/\D/g, '') });
    if (error) return { kind: 'unavailable', message: error.message ?? null };
    return parseIntakeTenantCheck(data, me);
  } catch (e) {
    return { kind: 'unavailable', message: e instanceof Error ? e.message : null };
  }
}

// ----- who is posting -----
export type BecomeAgentResult =
  | { ok: true }
  | { ok: false; code: 'PHONE_REQUIRED' | 'AGENT_ROLE_DISABLED' | 'OTHER'; message: string };

export function parseBecomeAgent(data: unknown, error: { message?: string; code?: string } | null): BecomeAgentResult {
  const o = obj(data);
  const text = [error?.message, error?.code, str(o?.code), str(o?.error), str(o?.status), str(o?.message)].filter(Boolean).join(' ');
  if (/PHONE_REQUIRED/i.test(text)) return { ok: false, code: 'PHONE_REQUIRED', message: str(o?.message) ?? 'Confirm your phone number first.' };
  if (/AGENT_ROLE_DISABLED/i.test(text)) {
    return { ok: false, code: 'AGENT_ROLE_DISABLED', message: str(o?.message) ?? (error?.message?.replace(/^AGENT_ROLE_DISABLED:?\s*/i, '') || 'Your agent role is switched off. Contact Welile support to turn it back on.') };
  }
  if (error || o?.ok === false) return { ok: false, code: 'OTHER', message: error?.message || str(o?.message) || 'Could not set you up to post. Try again.' };
  return { ok: true };
}

/** become_agent: the signed-in user may now post rent requests for someone else. */
export async function becomeAgent(): Promise<BecomeAgentResult> {
  try {
    const { data, error } = await rpc('become_agent', {});
    return parseBecomeAgent(data, error);
  } catch (e) {
    return { ok: false, code: 'OTHER', message: e instanceof Error ? e.message : 'Could not set you up to post. Try again.' };
  }
}

// ----- the tenant's photo -----
/**
 * face_check_record(p_request_id, p_status): what the background face check found for this
 * request ('ok', 'no_face', 'unavailable' or 'skipped_timeout'). Called once the request
 * exists. Best effort; never blocks.
 */
export async function recordFaceCheck(requestId: string, status: string): Promise<void> {
  try {
    const { error } = await rpc('face_check_record', { p_request_id: requestId, p_status: status });
    if (error) console.warn('[intake] face_check_record', error.message);
  } catch (e) {
    console.warn('[intake] face_check_record', e);
  }
}

// ----- resubmit -----
export interface ReturnItem { code: string; label: string | null }

export function parseReturnItems(raw: unknown): ReturnItem[] | null {
  let r: unknown = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
  if (r && !Array.isArray(r) && typeof r === 'object') r = (r as Record<string, unknown>).items ?? null;
  if (!Array.isArray(r)) return null;
  const out: ReturnItem[] = [];
  for (const x of r) {
    if (typeof x === 'string' && x.trim()) out.push({ code: x.trim().toLowerCase(), label: null });
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const code = str(o.item) ?? str(o.key) ?? str(o.code) ?? str(o.kind);
      if (code) out.push({ code: code.toLowerCase(), label: str(o.label) ?? str(o.note) ?? null });
    }
  }
  return out;
}

/** return_items_for: what the desk returned this request for, in order. null when it can't be read. */
export async function fetchReturnItems(requestId: string): Promise<ReturnItem[] | null> {
  try {
    const { data, error } = await rpc('return_items_for', { p_request_id: requestId });
    if (error) return null;
    return parseReturnItems(data);
  } catch {
    return null;
  }
}
