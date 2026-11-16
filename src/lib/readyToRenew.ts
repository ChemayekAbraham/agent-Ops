/**
 * E128: the agent dashboard's "Ready to renew" list, read from rpc('ready_to_renew').
 *
 * The RPC returns a JSON array of rows { tenant, agent, last_rent, last_days, completed_on,
 * tenant_asked }. The sub-shapes are not pinned down, so this parser accepts:
 * - `tenant` / `agent` as a plain name string, or an object { id, name | full_name, phone };
 *   flat fallbacks tenant_id / tenant_name / tenant_phone and agent_id / agent_name also count.
 * - the previous Rent Plan's request id as prev_request_id, last_request_id, request_id or id,
 *   either as a string or as an object carrying `id`; also prev_request / last_request /
 *   request objects with an `id`.
 * - the list itself as an array, a JSON string of one, or an object wrapping it in
 *   rows / items / data.
 * Rows without a previous request id are skipped (there is nothing to renew).
 * Anything that is not a list returns null.
 */

export interface ReadyToRenewRow {
  prevId: string;
  tenantId: string | null;
  tenantName: string;
  tenantPhone: string | null;
  agentId: string | null;
  agentName: string | null;
  lastRent: number;
  lastDays: number;
  completedOn: string | null;
  tenantAsked: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === 't';

/** An id given as a string, or as an object with an `id`. */
const idOf = (v: unknown): string | null => (isObj(v) ? str(v.id) : str(v));

/** A person given as a name string, or as { id, name | full_name, phone }. */
function person(v: unknown): { id: string | null; name: string | null; phone: string | null } {
  if (isObj(v)) {
    return {
      id: str(v.id) ?? str(v.user_id),
      name: str(v.name) ?? str(v.full_name),
      phone: str(v.phone) ?? str(v.phone_number),
    };
  }
  return { id: null, name: str(v), phone: null };
}

function listOf(raw: unknown): unknown[] | null {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (Array.isArray(v)) return v;
  if (isObj(v)) {
    for (const k of ['rows', 'items', 'data']) if (Array.isArray(v[k])) return v[k] as unknown[];
  }
  return null;
}

function prevIdOf(row: Obj): string | null {
  for (const k of ['prev_request_id', 'last_request_id', 'request_id', 'id']) {
    const id = idOf(row[k]);
    if (id) return id;
  }
  for (const k of ['prev_request', 'last_request', 'request']) {
    if (isObj(row[k])) {
      const id = str((row[k] as Obj).id);
      if (id) return id;
    }
  }
  return null;
}

const time = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/** Tenant asked first, then the most recently completed plan first. */
export function sortReadyToRenew(rows: ReadyToRenewRow[]): ReadyToRenewRow[] {
  return [...rows].sort((a, b) => {
    if (a.tenantAsked !== b.tenantAsked) return a.tenantAsked ? -1 : 1;
    return time(b.completedOn) - time(a.completedOn);
  });
}

export function parseReadyToRenew(raw: unknown): ReadyToRenewRow[] | null {
  const list = listOf(raw);
  if (!list) return null;
  const out: ReadyToRenewRow[] = [];
  for (const item of list) {
    if (!isObj(item)) continue;
    const prevId = prevIdOf(item);
    if (!prevId) continue;
    const tenant = person(item.tenant);
    const agent = person(item.agent);
    out.push({
      prevId,
      tenantId: tenant.id ?? str(item.tenant_id),
      tenantName: tenant.name ?? str(item.tenant_name) ?? 'Tenant',
      tenantPhone: tenant.phone ?? str(item.tenant_phone),
      agentId: agent.id ?? str(item.agent_id),
      agentName: agent.name ?? str(item.agent_name),
      lastRent: num(item.last_rent),
      lastDays: num(item.last_days),
      completedOn: str(item.completed_on),
      tenantAsked: bool(item.tenant_asked),
    });
  }
  return sortReadyToRenew(out);
}
