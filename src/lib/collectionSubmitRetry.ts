/**
 * Retry / idempotency / offline-queue plumbing around the EXISTING
 * `agent_allocate_tenant_payment` RPC. Never changes the arguments — amounts,
 * float, commission and ledger handling stay entirely server-side. The server
 * dedupes on `p_client_ref`, so resending the same args with the same ref is safe.
 */
import { safeUUID } from '@/lib/safeUUID';

export type AllocateArgs = {
  p_agent_id: string;
  p_tenant_id: string;
  p_rent_request_id: string;
  p_amount: number;
  p_notes: string | null;
  p_partial_confirmed: boolean;
  p_partial_reason: string | null;
  p_client_ref: string;
};

export type ErrorKind = 'transient_db' | 'network' | 'permission' | 'other';

const TRANSIENT_DB = new Set(['57014', '55P03', '40P01']);
const PERMISSION = new Set(['42501', '28000']);

export function classifyAllocateError(err: unknown): ErrorKind {
  if (!err) return 'other';
  const e = err as { code?: string; status?: number; message?: string; name?: string };
  const code = String(e.code ?? '');
  if (PERMISSION.has(code)) return 'permission';
  if (TRANSIENT_DB.has(code) || /^PGRST00\d$/.test(code)) return 'transient_db';
  if (e.status === 502 || e.status === 503 || e.status === 504) return 'transient_db';
  const msg = `${e.name ?? ''} ${e.message ?? ''}`.toLowerCase();
  if (
    msg.includes('failed to fetch') || msg.includes('load failed') ||
    msg.includes('networkerror') || msg.includes('timeout') || msg.includes('timed out')
  ) return 'network';
  return 'other';
}

/** ~1s, 2s, 4s with ±30% jitter. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = 1000 * 2 ** Math.max(0, attempt - 1);
  return Math.round(base * (0.7 + rand() * 0.6));
}

export type RpcResult = { data: unknown; error: unknown };

/**
 * Calls `fn` up to `maxAttempts` times while the failure is transient (DB
 * contention or network). Business rejections (`data.success === false`) and
 * permission errors are returned immediately and never retried.
 */
export async function callWithRetry(
  fn: () => Promise<RpcResult>,
  opts: {
    maxAttempts?: number;
    onRetry?: (attempt: number, kind: ErrorKind) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ result: RpcResult; attempts: number; lastKind: ErrorKind | null; recovered: boolean }> {
  const max = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastKind: ErrorKind | null = null;
  let result: RpcResult = { data: null, error: new Error('not attempted') };
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      result = await fn();
    } catch (thrown) {
      result = { data: null, error: thrown };
    }
    if (!result.error) {
      return { result, attempts: attempt, lastKind, recovered: lastKind !== null };
    }
    const kind = classifyAllocateError(result.error);
    lastKind = kind;
    if (kind !== 'transient_db' && kind !== 'network') break;
    if (attempt < max) {
      opts.onRetry?.(attempt + 1, kind);
      await sleep(backoffMs(attempt));
    } else {
      return { result, attempts: attempt, lastKind, recovered: false };
    }
  }
  return { result, attempts: max, lastKind, recovered: false };
}

// ── One client_ref per intended collection ─────────────────────────────────
// Kept at module level so closing and reopening the dialog for the SAME
// collection keeps the ref; cleared only on confirmed success.
const refs = new Map<string, string>();
const keyOf = (tenantId: string, planId: string, amount: number) => `${tenantId}:${planId}:${amount}`;

export function clientRefFor(tenantId: string, planId: string, amount: number): string {
  const k = keyOf(tenantId, planId, amount);
  let v = refs.get(k);
  if (!v) {
    // A queued, unsent collection for the same intent keeps its ref.
    v = listPendingCollections().find(
      (p) => p.args.p_tenant_id === tenantId && p.args.p_rent_request_id === planId && p.args.p_amount === amount,
    )?.args.p_client_ref ?? safeUUID();
    refs.set(k, v);
  }
  return v;
}

export function clearClientRef(tenantId: string, planId: string, amount: number): void {
  refs.delete(keyOf(tenantId, planId, amount));
}

// ── Local queue (exact original RPC args, keyed by client_ref) ─────────────
const QUEUE_KEY = 'welile.pendingCollections.v1';
export const QUEUE_EVENT = 'welile:pending-collections-changed';

export type PendingCollection = { args: AllocateArgs; queuedAt: string; tenantName?: string };

function read(): Record<string, PendingCollection> {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function write(q: Record<string, PendingCollection>) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    window.dispatchEvent(new Event(QUEUE_EVENT));
  } catch { /* storage full / private mode */ }
}

export function listPendingCollections(): PendingCollection[] {
  if (typeof localStorage === 'undefined') return [];
  return Object.values(read());
}

export function queueCollection(args: AllocateArgs, tenantName?: string): void {
  const q = read();
  if (!q[args.p_client_ref]) q[args.p_client_ref] = { args: { ...args }, queuedAt: new Date().toISOString(), tenantName };
  write(q);
}

export function removeQueuedCollection(clientRef: string): void {
  const q = read();
  if (q[clientRef]) {
    delete q[clientRef];
    write(q);
  }
}
