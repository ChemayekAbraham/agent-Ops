/**
 * Lightweight debug bus for credit-access loading-state transitions.
 *
 * Lets the floating CreditLoadingDebugPanel verify that the skeleton only
 * ever shows on a genuine cold load and never flashes during background
 * refreshes. DEV-only by default; force on with
 * `localStorage.setItem('welile-credit-debug','1')`.
 */

export type CreditLoadingEventType =
  | 'cold-load'        // skeleton shown — first ever load, no cache
  | 'background-refresh' // silent re-fetch (recalc), card stays visible
  | 'cache-hit'        // served instantly from memory cache, no spinner
  | 'realtime-refetch' // row changed elsewhere → read-only refetch
  | 'done';            // a fetch settled

export interface CreditLoadingEntry {
  id: number;
  ts: number;
  type: CreditLoadingEventType;
  userId: string;
  loading: boolean;
  note?: string;
}

export const CREDIT_DEBUG_EVENT = 'credit-loading:debug';
const MAX_ENTRIES = 50;

let seq = 0;
const buffer: CreditLoadingEntry[] = [];

export function isCreditDebugEnabled(): boolean {
  try {
    if (localStorage.getItem('welile-credit-debug') === '1') return true;
    if (localStorage.getItem('welile-credit-debug') === '0') return false;
  } catch { /* ignore */ }
  return Boolean(import.meta.env?.DEV);
}

export function getCreditDebugLog(): CreditLoadingEntry[] {
  return [...buffer];
}

export function clearCreditDebugLog() {
  buffer.length = 0;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CREDIT_DEBUG_EVENT));
  }
}

export function logCreditLoading(
  type: CreditLoadingEventType,
  opts: { userId: string | undefined; loading: boolean; note?: string },
) {
  if (!isCreditDebugEnabled()) return;
  const entry: CreditLoadingEntry = {
    id: ++seq,
    ts: Date.now(),
    type,
    userId: (opts.userId ?? '—').slice(0, 8),
    loading: opts.loading,
    note: opts.note,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CREDIT_DEBUG_EVENT, { detail: entry }));
  }
}
