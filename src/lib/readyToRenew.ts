/**
 * E128: the agent dashboard's "Ready to renew" list, read from rpc('ready_to_renew').
 *
 * The RPC (args p_all?, p_limit?) returns an array of rows:
 *   { last_request_id: uuid, ref: string,
 *     tenant: { id, name, phone }, agent: { id, name, phone },
 *     last_rent: number, last_days: number, repaid: number, total: number,
 *     completed_on: 'YYYY-MM-DD', tenant_asked: boolean }
 * last_request_id is the previous request that renew_rent_request renews. A row without it is
 * skipped; anything that is not an array returns null.
 */

export interface ReadyToRenewRow {
  prevId: string;
  ref: string | null;
  tenantId: string | null;
  tenantName: string;
  tenantPhone: string | null;
  agentId: string | null;
  agentName: string | null;
  lastRent: number;
  lastDays: number;
  repaid: number;
  total: number;
  completedOn: string | null;
  tenantAsked: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const person = (v: unknown) => (isObj(v) ? { id: str(v.id), name: str(v.name), phone: str(v.phone) } : { id: null, name: null, phone: null });

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
  if (!Array.isArray(raw)) return null;
  const out: ReadyToRenewRow[] = [];
  for (const item of raw) {
    if (!isObj(item)) continue;
    const prevId = str(item.last_request_id);
    if (!prevId) continue;
    const tenant = person(item.tenant);
    const agent = person(item.agent);
    out.push({
      prevId,
      ref: str(item.ref),
      tenantId: tenant.id,
      tenantName: tenant.name ?? 'Tenant',
      tenantPhone: tenant.phone,
      agentId: agent.id,
      agentName: agent.name,
      lastRent: num(item.last_rent),
      lastDays: num(item.last_days),
      repaid: num(item.repaid),
      total: num(item.total),
      completedOn: str(item.completed_on),
      tenantAsked: item.tenant_asked === true,
    });
  }
  return sortReadyToRenew(out);
}
