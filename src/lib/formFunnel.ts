/**
 * Demand funnel tracking (E108) for the rent request forms: where people stop, and why.
 *
 * Every event goes to request_form_log, fire-and-forget: nothing here is awaited by the
 * form, nothing is ever shown to the user, and nothing throws. Offline (or when the
 * network drops) events wait in localStorage and are sent once the phone is back online.
 *
 * One session per opening of a form; a successful post ends it, and the next open starts a
 * new one.
 */
import { supabase } from '@/integrations/supabase/client';
import { safeUUID } from '@/lib/safeUUID';

export type FunnelForm = 'agent_post' | 'tenant_self';
export type FunnelEvent = 'open' | 'step' | 'blocked' | 'item_done' | 'submit_ok' | 'submit_fail' | 'close';
export const FUNNEL_STEPS = ['start', 'repayment', 'tenant', 'house_landlord', 'gps', 'smartphone', 'lc1', 'documents', 'review'] as const;
export type FunnelStep = typeof FUNNEL_STEPS[number];
export const FUNNEL_ITEMS = [
  'house_photos', 'landlord', 'rent', 'gps', 'family_size', 'work', 'id_front', 'id_back', 'lc1_letter',
  'tenant_photo', 'phone', 'agreement', 'duplicate', 'other',
] as const;
export type FunnelItem = typeof FUNNEL_ITEMS[number];

export interface FunnelRow {
  p_session: string;
  p_event: FunnelEvent;
  p_step: string | null;
  p_items: FunnelItem[] | null;
  p_error: string | null;
  p_rent_request_id: string | null;
  p_meta: Record<string, unknown>;
  p_form: FunnelForm;
}

export const FUNNEL_QUEUE_KEY = 'welile-form-funnel-queue';
const QUEUE_MAX = 300;

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>;
const defaultRpc: Rpc = (fn, args) => (supabase.rpc as unknown as Rpc).call(supabase, fn, args);

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const isNetworkError = (msg: string | undefined) =>
  /failed to fetch|network|load failed|fetch failed|timeout|aborted|ERR_INTERNET|ERR_NETWORK/i.test(msg || '');

function readQueue(): FunnelRow[] {
  try {
    const raw = localStorage.getItem(FUNNEL_QUEUE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeQueue(rows: FunnelRow[]) {
  try {
    if (rows.length) localStorage.setItem(FUNNEL_QUEUE_KEY, JSON.stringify(rows.slice(-QUEUE_MAX)));
    else localStorage.removeItem(FUNNEL_QUEUE_KEY);
  } catch { /* storage full or blocked: drop it, tracking is never worth an error */ }
}
const enqueue = (row: FunnelRow) => writeQueue([...readQueue(), row]);

/** Sends one row; queues it when the network is the problem. Never rejects. */
async function sendRow(row: FunnelRow, rpc: Rpc): Promise<boolean> {
  if (isOffline()) { enqueue(row); return false; }
  try {
    const { error } = await rpc('request_form_log', row as unknown as Record<string, unknown>);
    if (error) {
      if (isNetworkError(error.message)) enqueue(row);
      return false; // a server refusal is dropped: re-sending would refuse again
    }
    return true;
  } catch (e) {
    enqueue(row);
    void e;
    return false;
  }
}

let flushing = false;
/** Sends what waited offline, oldest first. Safe to call any time; never rejects. */
export async function flushFunnelQueue(rpc: Rpc = defaultRpc): Promise<void> {
  if (flushing || isOffline()) return;
  const rows = readQueue();
  if (!rows.length) return;
  flushing = true;
  writeQueue([]);
  try {
    for (let i = 0; i < rows.length; i++) {
      const ok = await sendRow(rows[i], rpc);
      if (!ok && isOffline()) { writeQueue([...rows.slice(i + 1), ...readQueue()]); break; }
    }
  } catch { /* never */ } finally {
    flushing = false;
  }
}

let onlineBound = false;
function bindOnline() {
  if (onlineBound || typeof window === 'undefined') return;
  onlineBound = true;
  try { window.addEventListener('online', () => { void flushFunnelQueue(); }); } catch { /* ignore */ }
}

export interface FormFunnel {
  readonly session: string;
  open(meta?: Record<string, unknown>): void;
  step(step: FunnelStep): void;
  blocked(items: FunnelItem[], error?: string | null): void;
  itemDone(item: FunnelItem): void;
  submitOk(rentRequestId: string): void;
  submitFail(error: string, items?: FunnelItem[] | null): void;
  /** Closed without posting; `meta` e.g. { saved_draft: true }. */
  close(meta?: Record<string, unknown>): void;
}

/**
 * The funnel for one form. `rpc` is only for tests. Every method is fire-and-forget and
 * swallows every error.
 */
export function createFormFunnel(form: FunnelForm, rpc: Rpc = defaultRpc): FormFunnel {
  bindOnline();
  let session = safeUUID();
  let opened = false;
  let posted = false;
  let closed = false;
  let lastStep: string | null = null;
  let done = new Set<FunnelItem>();

  const emit = (event: FunnelEvent, extra: Partial<FunnelRow> = {}) => {
    try {
      const row: FunnelRow = {
        p_session: session,
        p_event: event,
        p_step: extra.p_step ?? lastStep,
        p_items: extra.p_items ?? null,
        p_error: extra.p_error ?? null,
        p_rent_request_id: extra.p_rent_request_id ?? null,
        p_meta: { client_at: new Date().toISOString(), ...(extra.p_meta ?? {}) },
        p_form: form,
      };
      void sendRow(row, rpc).then((ok) => { if (ok) void flushFunnelQueue(rpc); }).catch(() => {});
    } catch { /* tracking never breaks the form */ }
  };
  const clean = (items: FunnelItem[] | null | undefined) =>
    Array.from(new Set((items ?? []).filter((i) => (FUNNEL_ITEMS as readonly string[]).includes(i))));

  return {
    get session() { return session; },
    open(meta) {
      // A fresh session after a post (or for the very first open of a used funnel).
      if (posted || opened) {
        session = safeUUID();
        done = new Set();
        lastStep = null;
      }
      opened = true; posted = false; closed = false;
      emit('open', { p_meta: meta, p_step: null });
    },
    step(step) {
      if (!opened || step === lastStep) return;
      lastStep = step;
      emit('step', { p_step: step });
    },
    blocked(items, error) {
      if (!opened) return;
      emit('blocked', { p_items: clean(items).length ? clean(items) : ['other'], p_error: error ?? null });
    },
    itemDone(item) {
      if (!opened || done.has(item) || !(FUNNEL_ITEMS as readonly string[]).includes(item)) return;
      done.add(item);
      emit('item_done', { p_items: [item] });
    },
    submitOk(rentRequestId) {
      if (!opened) return;
      emit('submit_ok', { p_rent_request_id: rentRequestId });
      posted = true;
    },
    submitFail(error, items) {
      if (!opened) return;
      const list = clean(items);
      emit('submit_fail', { p_error: error || 'unknown', p_items: list.length ? list : null });
    },
    close(meta) {
      if (!opened || posted || closed) return;
      closed = true;
      emit('close', meta ? { p_meta: meta } : {});
    },
  };
}

/** The server's error code at the start of a message ("REQUIREMENTS_MISSING: …"), or the fallback. */
export function funnelErrorCode(message: string | null | undefined, fallback = 'unknown'): string {
  const m = /^\s*([A-Z][A-Z0-9_]{3,})\b/.exec(message || '');
  return m ? m[1] : fallback;
}
