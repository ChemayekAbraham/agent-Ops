/**
 * "Does this record already exist?" checks for the Rent Request Assistant.
 *
 * The assistant must stop on a tenant phone or National ID that is already on
 * Welile, and must never say whose it is. Every check here returns a verdict
 * only: the RPCs that also return a name have that name dropped before it
 * leaves this file, so no screen can show it by mistake.
 *
 * Checks fail closed: if a lookup errors, the verdict is 'unknown' and the
 * assistant asks the agent to try again instead of moving on.
 */
import { supabase } from '@/integrations/supabase/client';

/** Where an existing record was found. Never carries who owns it. */
export type RecordHit = 'account' | 'landlord' | 'lc1' | 'self';

export type RecordVerdict =
  | { status: 'free' }
  | { status: 'taken'; hit: RecordHit }
  | { status: 'unknown' };

type UntypedRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

/** Last 9 digits of a Ugandan number, or null. Same comparison the form's hooks use. */
const local9 = (phone: string | null | undefined): string | null => {
  const d = (phone || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
};

/** Same folding as public.normalize_national_id_fuzzy (O→0, I→1, L→1, S→5, B→8, Z→2). */
const fuzzyNin = (nin: string | null | undefined): string =>
  (nin || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().replace(/[OILSBZ]/g, (c) => ({ O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' })[c] as string);

export interface AgentSelf {
  phone: string | null;
  nationalId: string | null;
}

/** The signed-in agent's own phone and NIN. The server checks skip the caller, so the assistant compares these itself. */
export async function loadAgentSelf(agentId: string, fallbackPhone?: string | null): Promise<AgentSelf> {
  const { data } = await supabase.from('profiles').select('phone, national_id').eq('id', agentId).maybeSingle();
  const row = data as { phone?: string | null; national_id?: string | null } | null;
  return { phone: row?.phone || fallbackPhone || null, nationalId: row?.national_id || null };
}

/**
 * Is this number already a Welile account, a landlord or an LC1?
 * A tenant's number must be new to all three.
 */
export async function checkTenantPhone(phone: string, self: AgentSelf | null): Promise<RecordVerdict> {
  const l9 = local9(phone);
  if (!l9) return { status: 'unknown' };
  if (self && local9(self.phone) === l9) return { status: 'taken', hit: 'self' };
  try {
    const [acct, landlord, lc1] = await Promise.all([
      rpc('is_phone_available', { p_phone: `0${l9}` }),
      rpc('find_landlord_duplicate', { p_name: '', p_phone: `0${l9}` }),
      rpc('find_lc1_by_phone', { p_phone: `0${l9}` }),
    ]);
    if (acct.error || landlord.error || lc1.error) return { status: 'unknown' };
    if (acct.data === false) return { status: 'taken', hit: 'account' };
    if (Array.isArray(landlord.data) && landlord.data.length > 0) return { status: 'taken', hit: 'landlord' };
    if (Array.isArray(lc1.data) && lc1.data.length > 0) return { status: 'taken', hit: 'lc1' };
    return { status: 'free' };
  } catch {
    return { status: 'unknown' };
  }
}

/** Is this National ID already on another account (profiles or a verified payout ID)? */
export async function checkNationalId(nin: string, self: AgentSelf | null): Promise<RecordVerdict> {
  const f = fuzzyNin(nin);
  if (f.length < 6) return { status: 'unknown' };
  if (self?.nationalId && fuzzyNin(self.nationalId) === f) return { status: 'taken', hit: 'self' };
  try {
    const { data, error } = await rpc('national_id_holder_hint', { p_nin: nin });
    if (error) return { status: 'unknown' };
    // The hint also returns a first name; only `found` is read.
    return (data as { found?: boolean } | null)?.found ? { status: 'taken', hit: 'account' } : { status: 'free' };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * A new LC1's number must not be the agent's own or a landlord's.
 * (An LC1 may already have a Welile account, so accounts are not checked.)
 */
export async function checkNewLc1Phone(phone: string, self: AgentSelf | null): Promise<RecordVerdict> {
  const l9 = local9(phone);
  if (!l9) return { status: 'unknown' };
  if (self && local9(self.phone) === l9) return { status: 'taken', hit: 'self' };
  try {
    const { data, error } = await rpc('find_landlord_duplicate', { p_name: '', p_phone: `0${l9}` });
    if (error) return { status: 'unknown' };
    return Array.isArray(data) && data.length > 0 ? { status: 'taken', hit: 'landlord' } : { status: 'free' };
  } catch {
    return { status: 'unknown' };
  }
}

/** 0783 123 456 → 0783 ••• 456, so the agent can see which number was refused. */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length >= 10 ? `${d.slice(0, 4)} ••• ${d.slice(-3)}` : '••••';
}

/** CM90… → CM•••••••12AB: first two and last four only. */
export function maskNationalId(nin: string): string {
  const c = nin.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return c.length > 6 ? `${c.slice(0, 2)}${'•'.repeat(c.length - 6)}${c.slice(-4)}` : '••••';
}
