import { safeUUID } from '@/lib/safeUUID';
/**
 * Login phase telemetry.
 *
 * Records timestamped phase markers for the entire sign-in / bootstrap
 * pipeline (session restore → getUser → role fetch → gates → route ready)
 * so we can pinpoint exactly where a spinner hangs on a specific device.
 *
 * Buffered locally (in-memory + localStorage ring) and best-effort mirrored
 * to `public.login_phase_events` for cross-device forensic analysis.
 *
 * Usage:
 *   import { loginTelemetry as lt } from '@/lib/loginTelemetry';
 *   lt.mark('auth.getSession.start');
 *   ...
 *   lt.mark('auth.getSession.end', { status: 'ok' });
 *
 * Debug in DevTools:
 *   window.__welileLoginTelemetry.dump()
 */
import { supabase } from '@/integrations/supabase/client';

type PhaseDetail = Record<string, unknown> | undefined;

export interface PhaseEvent {
  phase: string;
  status?: string;
  ms_since_start: number;
  duration_ms?: number;
  detail?: PhaseDetail;
  at: number; // epoch ms
}

const LS_KEY = 'welile_login_telemetry_v1';
const TRACE_KEY = 'welile_login_trace_id';
const MAX_EVENTS = 200;
const FLUSH_INTERVAL_MS = 4000;
const MAX_PENDING = 40;

function genTraceId() {
  try {
    return safeUUID();
  } catch { /* ignore */ }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadTraceId(): string {
  try {
    const existing = sessionStorage.getItem(TRACE_KEY);
    if (existing) return existing;
    const fresh = genTraceId();
    sessionStorage.setItem(TRACE_KEY, fresh);
    return fresh;
  } catch {
    return genTraceId();
  }
}

function saveRing(events: PhaseEvent[]) {
  try {
    const trimmed = events.slice(-MAX_EVENTS);
    localStorage.setItem(LS_KEY, JSON.stringify({ trace: state.traceId, events: trimmed }));
  } catch { /* quota / private mode */ }
}

function loadRing(): PhaseEvent[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.events)) return parsed.events as PhaseEvent[];
  } catch { /* ignore */ }
  return [];
}

interface State {
  start: number;
  traceId: string;
  events: PhaseEvent[];
  pending: PhaseEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  userId: string | null;
  starts: Map<string, number>;
}

/**
 * `user_id` safe to INSERT under `login_phase_events` policy
 * `telemetry insert own`: NULL, or exactly `auth.uid()`.
 *
 * A cached / previous-account id on an anonymous request (or on someone
 * else's JWT) is rejected with 42501 and spams Postgres. When nothing was
 * recorded, the live session user is used — that is `auth.uid()` for this
 * request. A recorded id that disagrees with the session is omitted.
 */
export function loginPhaseEventUserId(
  recordedUserId: string | null,
  sessionUserId: string | null,
): string | null {
  if (!sessionUserId) return null;
  if (recordedUserId && recordedUserId !== sessionUserId) return null;
  return sessionUserId;
}

function isRlsOrPrivilegeError(error: { code?: string; message?: string }): boolean {
  if (error.code === '42501') return true;
  const message = error.message?.toLowerCase() ?? '';
  return message.includes('row-level security') || message.includes('permission denied');
}

const state: State = {
  start: (typeof performance !== 'undefined' && performance.now) ? performance.timeOrigin : Date.now(),
  traceId: 'pending',
  events: [],
  pending: [],
  flushTimer: null,
  userId: null,
  starts: new Map(),
};

function ensureInit() {
  if (state.traceId !== 'pending') return;
  state.traceId = loadTraceId();
  state.events = loadRing();
  // Anchor "ms_since_start" to the earliest recorded event this trace, if any;
  // otherwise anchor to now.
  if (state.events.length > 0) {
    state.start = state.events[0].at;
  } else {
    state.start = Date.now();
  }
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

/** Session user the next PostgREST call will present, or null when it will be anon. */
async function currentSessionUserId(): Promise<string | null> {
  try {
    // getSession blocks until initial load / token refresh finishes, so this is
    // the same identity `insert` will put on the Authorization header.
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    const session = data.session;
    if (!session?.access_token || !session.user?.id) return null;
    return session.user.id;
  } catch {
    return null;
  }
}

// Serializes flushes so a sign-in flushNow waits for an in-flight drain
// instead of dropping the row that just landed in `pending`.
let flushTail: Promise<void> = Promise.resolve();

function flush(): Promise<void> {
  const run = flushTail.then(drain, drain);
  flushTail = run.then(() => undefined, () => undefined);
  return run;
}

async function drain(): Promise<void> {
  if (state.pending.length === 0) return;
  const batch = state.pending.splice(0, state.pending.length);
  const path = typeof window !== 'undefined' ? window.location?.pathname ?? null : null;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : null;
  try {
    const sessionUserId = await currentSessionUserId();
    const userId = loginPhaseEventUserId(state.userId, sessionUserId);
    // Forget a stale cached id. The next batch follows the live session.
    state.userId = sessionUserId;
    const rows = batch.map((e) => ({
      user_id: userId,
      session_trace_id: state.traceId,
      phase: e.phase,
      status: e.status ?? null,
      ms_since_start: e.ms_since_start,
      duration_ms: e.duration_ms ?? null,
      detail: e.detail ?? null,
      user_agent: ua,
      path,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from('login_phase_events').insert(rows);
    if (!error) return;
    // A Postgres rejection (RLS 42501 or any other SQLSTATE) is dropped.
    // Replaying it is how this table spammed the database log. Transport
    // failures have no SQLSTATE and are retried once the timer fires.
    const code = error.code ?? '';
    if (isRlsOrPrivilegeError(error) || /^[0-9A-Z]{5}$/.test(code)) return;
    state.pending = [...batch, ...state.pending].slice(-MAX_PENDING);
    scheduleFlush();
  } catch {
    // Restore for a later retry, capped to avoid unbounded growth.
    state.pending = [...batch, ...state.pending].slice(-MAX_PENDING);
    scheduleFlush();
  }
}

function record(phase: string, status: string | undefined, detail: PhaseDetail, durationMs?: number) {
  ensureInit();
  const now = Date.now();
  const evt: PhaseEvent = {
    phase,
    status,
    detail,
    duration_ms: durationMs,
    ms_since_start: Math.max(0, now - state.start),
    at: now,
  };
  state.events.push(evt);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  saveRing(state.events);

  // Console breadcrumb — keep it tight so it's grep-able in remote reports.
  try {
    // eslint-disable-next-line no-console
    console.debug(
      `[LoginTelemetry] +${evt.ms_since_start}ms ${phase}${status ? ` [${status}]` : ''}`,
      detail || '',
    );
  } catch { /* ignore */ }

  state.pending.push(evt);
  if (state.pending.length >= MAX_PENDING) {
    void flush();
  } else {
    scheduleFlush();
  }
}

export const loginTelemetry = {
  /** Record a single phase marker. */
  mark(phase: string, detail?: PhaseDetail, status?: string) {
    record(phase, status, detail);
  },
  /** Record a phase START and return a stopper you call when the phase completes. */
  start(phase: string, detail?: PhaseDetail) {
    ensureInit();
    const t0 = Date.now();
    state.starts.set(phase, t0);
    record(`${phase}.start`, undefined, detail);
    return (endStatus?: string, endDetail?: PhaseDetail) => {
      const started = state.starts.get(phase) ?? t0;
      state.starts.delete(phase);
      const dur = Date.now() - started;
      record(`${phase}.end`, endStatus, endDetail, dur);
    };
  },
  /**
   * Remember who this browser thinks is signed in. Uploads still omit
   * `user_id` unless that id is the live session user (`auth.uid()`).
   */
  setUserId(userId: string | null) {
    state.userId = userId;
  },
  /** Rotate the trace (e.g. on explicit sign-out / sign-in). */
  resetTrace() {
    const fresh = genTraceId();
    state.traceId = fresh;
    state.start = Date.now();
    state.events = [];
    state.pending = [];
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    try { sessionStorage.setItem(TRACE_KEY, fresh); } catch { /* ignore */ }
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  },
  /** Force an immediate flush (best-effort). */
  flushNow() { return flush(); },
  /** Return the recent in-memory ring for the diagnostics UI. */
  dump() {
    ensureInit();
    return {
      traceId: state.traceId,
      userId: state.userId,
      startedAt: new Date(state.start).toISOString(),
      events: [...state.events],
    };
  },
  /** Explicit init: safe to call anywhere. */
  init() { ensureInit(); },
  /** Current trace id. */
  traceId() { ensureInit(); return state.traceId; },
};

// Expose in the browser for on-device debugging.
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__welileLoginTelemetry = loginTelemetry;
}

// Best-effort flush on tab hide / unload so short-lived sessions still upload.
if (typeof window !== 'undefined') {
  const finalFlush = () => { void flush(); };
  window.addEventListener('pagehide', finalFlush);
  window.addEventListener('beforeunload', finalFlush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') finalFlush();
  });
}

// Auto-record when the stale-session detector fires, so we can see a bad_jwt
// hit interleaved with the phase timeline.
if (typeof window !== 'undefined') {
  window.addEventListener('welile:session-stale', ((e: Event) => {
    const detail = (e as CustomEvent).detail;
    loginTelemetry.mark('auth.stale_session.detected', detail);
  }) as EventListener);
  window.addEventListener('welile:session-rehydrated', ((e: Event) => {
    const detail = (e as CustomEvent).detail;
    loginTelemetry.mark('auth.stale_session.rehydrated', detail);
  }) as EventListener);
}
