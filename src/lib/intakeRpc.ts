/**
 * The E124 intake calls, read with their exact E127 reply shapes: who may post
 * (become_agent), the step-1 tenant check (intake_tenant_check), the face-check record
 * (face_check_record) and what a returned request must fix (return_items_for). Nothing here throws.
 */
import { supabase } from '@/integrations/supabase/client';

type RpcError = { message?: string; code?: string } | null;
type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

// ----- step 1: the tenant's phone -----
/**
 * intake_tenant_check(p_tenant_phone) replies
 *   { status: 'ok' | 'own_phone' | 'open_request' | 'returned_mine' | 'returned_other',
 *     ok, own_phone, open_request: { id, mine, where } | null,
 *     returned_request: { id, mine, reason } | null, message }
 * or, for a phone that is too short, { ok: false, reason: 'phone_incomplete', message }.
 */
export type IntakeTenantCheck =
  | { kind: 'ok' }
  | { kind: 'own_phone'; message: string | null }
  | { kind: 'open_request'; mine: boolean; requestId: string | null; where: string | null; message: string | null }
  | { kind: 'returned_request'; mine: boolean; requestId: string | null; reason: string | null; message: string | null }
  | { kind: 'phone_incomplete'; message: string | null }
  | { kind: 'unavailable'; message: string | null };

export function parseIntakeTenantCheck(raw: unknown): IntakeTenantCheck {
  const o = rec(raw) ?? {};
  const status = str(o.status);
  const message = str(o.message);
  const open = rec(o.open_request);
  const returned = rec(o.returned_request);
  if (status === 'phone_incomplete' || str(o.reason) === 'phone_incomplete') return { kind: 'phone_incomplete', message };
  switch (status) {
    case 'ok': return { kind: 'ok' };
    case 'own_phone': return { kind: 'own_phone', message };
    case 'open_request':
      return { kind: 'open_request', mine: open?.mine === true, requestId: str(open?.id), where: str(open?.where), message };
    case 'returned_mine':
    case 'returned_other':
      return { kind: 'returned_request', mine: status === 'returned_mine', requestId: str(returned?.id), reason: str(returned?.reason), message };
    default:
      // An unknown status is not a reason to stop the agent; the database still refuses what it must.
      return o.ok === false ? { kind: 'unavailable', message } : { kind: 'ok' };
  }
}

/** intake_tenant_check for the tenant's phone; 'unavailable' when it could not be read. */
export async function checkIntakeTenant(phone: string): Promise<IntakeTenantCheck> {
  try {
    const { data, error } = await rpc('intake_tenant_check', { p_tenant_phone: phone.replace(/\D/g, '') });
    if (error) return { kind: 'unavailable', message: error.message ?? null };
    return parseIntakeTenantCheck(data);
  } catch (e) {
    return { kind: 'unavailable', message: e instanceof Error ? e.message : null };
  }
}

// ----- who is posting -----
/**
 * become_agent() replies { ok, already_agent }. PHONE_REQUIRED and AGENT_ROLE_DISABLED come
 * as errors (exceptions) whose message starts with that code.
 */
export type BecomeAgentResult =
  | { ok: true; alreadyAgent: boolean }
  | { ok: false; code: 'PHONE_REQUIRED' | 'AGENT_ROLE_DISABLED' | 'OTHER'; message: string };

/** The words after the code: "PHONE_REQUIRED: Confirm your phone" -> "Confirm your phone". */
const after = (message: string, code: string) => message.slice(code.length).replace(/^[\s:\-–—]+/, '').trim();

export function parseBecomeAgent(data: unknown, error: RpcError): BecomeAgentResult {
  if (error) {
    const m = (error.message ?? '').trim();
    if (m.startsWith('PHONE_REQUIRED')) return { ok: false, code: 'PHONE_REQUIRED', message: after(m, 'PHONE_REQUIRED') || 'Confirm your phone number first.' };
    if (m.startsWith('AGENT_ROLE_DISABLED')) {
      return { ok: false, code: 'AGENT_ROLE_DISABLED', message: after(m, 'AGENT_ROLE_DISABLED') || 'Your agent role is switched off. Contact Welile support to turn it back on.' };
    }
    return { ok: false, code: 'OTHER', message: m || 'Could not set you up to post. Try again.' };
  }
  const o = rec(data);
  if (o?.ok !== true) return { ok: false, code: 'OTHER', message: 'Could not set you up to post. Try again.' };
  return { ok: true, alreadyAgent: o.already_agent === true };
}

/** become_agent: the signed-in user may now post rent requests for someone else. */
export async function becomeAgent(): Promise<BecomeAgentResult> {
  try {
    const { data, error } = await rpc('become_agent', {});
    return parseBecomeAgent(data, error);
  } catch (e) {
    return parseBecomeAgent(null, { message: e instanceof Error ? e.message : String(e) });
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

/** return_items_for(p_request_id) replies { items: string[], note, by, at }; items is [] when nothing was named. */
export function parseReturnItems(raw: unknown): ReturnItem[] | null {
  const o = rec(raw);
  if (!o || !Array.isArray(o.items)) return null;
  return o.items
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => ({ code: x.trim().toLowerCase(), label: null }));
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
