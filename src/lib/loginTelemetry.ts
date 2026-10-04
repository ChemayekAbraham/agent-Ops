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
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as Crypto).randomUUID();
    }
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

async function flush() {
  if (state.pending.length === 0) return;
  const batch = state.pending.splice(0, state.pending.length);
  const path = typeof window !== 'undefined' ? window.location?.pathname ?? null : null;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : null;
  const rows = batch.map((e) => ({
    user_id: state.userId,
    session_trace_id: state.traceId,
    phase: e.phase,
    status: e.status ?? null,
    ms_since_start: e.ms_since_start,
    duration_ms: e.duration_ms ?? null,
    detail: e.detail ?? null,
    user_agent: ua,
    path,
  }));
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('login_phase_events').insert(rows);
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
  /** Attach the resolved user id to subsequent uploaded rows. */
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
