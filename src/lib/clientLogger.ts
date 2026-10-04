/**
 * Tiny structured client-side logger.
 *
 * - Emits a single console line per event using `console.error` /
 *   `console.warn` / `console.info` with a stable `[evt]` prefix so log
 *   pipelines (Sentry breadcrumbs, browser DevTools, Lovable session replay)
 *   can grep for it.
 * - Always JSON-serialises the payload so structured fields (partner_id,
 *   error_code, request_id, ...) survive copy-paste from a bug report.
 * - Keeps an in-memory ring buffer (last 100 events) on
 *   `window.__welile_logs` for ad-hoc debugging from the console.
 */
type Level = 'info' | 'warn' | 'error';

export interface LogEvent {
  ts: string;          // ISO timestamp
  level: Level;
  event: string;       // dot.separated event name
  [key: string]: unknown;
}

const RING_LIMIT = 100;

function pushRing(entry: LogEvent) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __welile_logs?: LogEvent[] };
  if (!Array.isArray(w.__welile_logs)) w.__welile_logs = [];
  w.__welile_logs.push(entry);
  if (w.__welile_logs.length > RING_LIMIT) {
    w.__welile_logs.splice(0, w.__welile_logs.length - RING_LIMIT);
  }
}

/**
 * Best-effort forward to Sentry when a Sentry SDK is present on the page
 * (`window.Sentry`). No hard dependency: if Sentry isn't wired up this is a
 * no-op, and if it is, every structured log becomes a breadcrumb and errors
 * are captured. Never throws.
 */
function forwardToSentry(level: Level, event: string, entry: LogEvent, error?: unknown) {
  try {
    const S = (typeof window !== 'undefined' ? (window as any).Sentry : undefined);
    if (!S) return;
    if (typeof S.addBreadcrumb === 'function') {
      S.addBreadcrumb({
        category: 'welile',
        level: level === 'warn' ? 'warning' : level,
        message: event,
        data: entry,
      });
    }
    if (level === 'error') {
      if (error != null && typeof S.captureException === 'function') {
        S.captureException(error, { extra: entry, tags: { event } });
      } else if (typeof S.captureMessage === 'function') {
        S.captureMessage(event, { level: 'error', extra: entry, tags: { event } });
      }
    }
  } catch {
    // Sentry forwarding must never break logging.
  }
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const entry: LogEvent = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  pushRing(entry);
  const sink =
    level === 'error' ? console.error
    : level === 'warn' ? console.warn
    : console.info;
  // Keep the message short + structured JSON for grep-ability.
  sink(`[evt] ${event}`, entry);
  // Forward to Sentry when available. Pull the raw Error (if any) out of the
  // fields so captureException gets a real stack.
  forwardToSentry(level, event, entry, (fields as any)?.error);
}

export const clientLog = {
  info:  (event: string, fields?: Record<string, unknown>) => emit('info',  event, fields),
  warn:  (event: string, fields?: Record<string, unknown>) => emit('warn',  event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};
