import { toast } from 'sonner';
/**
 * Centralized client-side error reporting pipeline.
 *
 * Currently writes to the `client_error_reports` table (visible to managers
 * via RLS). Designed as the single funnel so swapping in Sentry / Datadog /
 * any other provider later only requires editing this file.
 *
 * All reports are automatically tagged with route + user role + user id so
 * crashes are traceable per role and per page.
 */
import { supabase } from '@/integrations/supabase/client';
import { CANONICAL_ORIGIN } from '@/lib/getPublicOrigin';
import { isIgnorableClientError } from '@/lib/errorNoiseFilter';
import { installChunkPreloadRecovery, isChunkLoadError, wasRecentChunkReload } from '@/lib/lazyWithRetry';

/**
 * Only report from the canonical production origin. `client_error_reports`
 * feeds the daily CTO report presented to the CEO/Board as production
 * incidents — local dev (localhost:8080) and Lovable preview/editor traffic
 * (*.lovableproject.com, id-preview--*.lovable.app) were polluting it with
 * mid-edit noise (e.g. a briefly-missing import self-corrected before the
 * commit landed) that real users never saw. See 2026-09-03 report: 5 of 7
 * "new" errors that day sourced to localhost or the preview domain.
 */
function isProductionOrigin(): boolean {
  return typeof window !== 'undefined' && window.location.origin === CANONICAL_ORIGIN;
}

type ReportSource =
  | 'dashboard-error-boundary'
  | 'window-onerror'
  | 'unhandled-rejection'
  | 'manual';

export interface ErrorReportInput {
  source: ReportSource;
  /** Friendly label, e.g. "agent dashboard". */
  label?: string | null;
  message?: string | null;
  componentStack?: string | null;
  stack?: string | null;
  /** Extra free-form context (merged into the `context` jsonb column). */
  extra?: Record<string, unknown>;
}

interface TagContext {
  userId: string | null;
  role: string | null;
}

// Module-level tag context — kept in sync from useAuth via setReportingTags().
let currentTags: TagContext = { userId: null, role: null };

/** Update the user/role tags attached to every subsequent error report. */
export function setReportingTags(tags: Partial<TagContext>) {
  currentTags = { ...currentTags, ...tags };
}

/** Best-effort deduplication for noisy duplicate errors (5s window). */
const recentSignatures = new Map<string, number>();
const DEDUPE_WINDOW_MS = 5_000;

const ABORT_RE = /signal is aborted without reason|the user aborted a request|the operation was aborted|aborterror/i;
const AUDIO_START_RE = /failed to start the audio device|could not start (audio|video) source|requested device not found|permission denied by system/i;
const AUDIO_ERROR_NAMES = new Set(['NotAllowedError', 'NotFoundError', 'NotReadableError']);

/** Cancelled requests (component unmounted, navigation) are not crashes. */
export function isAbortLike(errOrMessage: unknown): boolean {
  if (!errOrMessage) return false;
  const e = errOrMessage as { name?: unknown; message?: unknown };
  if (typeof e === 'object' && e.name === 'AbortError') return true;
  const msg = typeof errOrMessage === 'string' ? errOrMessage : String(e.message ?? '');
  return ABORT_RE.test(msg);
}

/** Microphone/audio could not start (permissions, busy or missing device). */
export function isAudioStartError(errOrMessage: unknown): boolean {
  if (!errOrMessage) return false;
  const e = errOrMessage as { name?: unknown; message?: unknown };
  const msg = typeof errOrMessage === 'string' ? errOrMessage : String(e.message ?? '');
  if (AUDIO_START_RE.test(msg)) return true;
  return typeof e === 'object' && typeof e.name === 'string' && AUDIO_ERROR_NAMES.has(e.name) && /audio|microphone|device|media/i.test(msg);
}

let lastAudioToast = 0;
function notifyAudioStartFailed() {
  const now = Date.now();
  if (now - lastAudioToast < 10_000) return;
  lastAudioToast = now;
  toast.error('Could not start the microphone/audio. Check permissions and try again.');
}

function shouldDedupe(signature: string) {
  const now = Date.now();
  for (const [k, t] of recentSignatures) {
    if (now - t > DEDUPE_WINDOW_MS) recentSignatures.delete(k);
  }
  if (recentSignatures.has(signature)) return true;
  recentSignatures.set(signature, now);
  return false;
}

/**
 * Send a single error to the reporting pipeline. Always resolves — never
 * throws — so callers (including error boundaries) are safe to await.
 */
export async function reportClientError(input: ErrorReportInput): Promise<boolean> {
  // Dev/preview errors stay visible in that environment's own console —
  // they just never reach the table the CTO report reads as "production".
  if (!isProductionOrigin()) return true;
  // Cancelled requests and audio-start refusals are not crashes.
  if (isAbortLike(input.message) || isAudioStartError(input.message)) return true;

  // Browser-extension / injected-script noise is not an app error.
  const filename = typeof input.extra?.filename === 'string' ? input.extra.filename : null;
  if (isIgnorableClientError(input.message ?? '', input.stack ?? input.componentStack ?? null, filename)) return true;
  // A stale chunk that the guarded one-time reload is already recovering from.
  if (isChunkLoadError({ message: input.message ?? '' }) && wasRecentChunkReload()) return true;

  const route = typeof window !== 'undefined' ? window.location.pathname : null;
  const signature = `${input.source}|${input.message ?? ''}|${route ?? ''}`;
  // Manual user-triggered reports always go through, even if the same error
  // was just auto-captured by the boundary.
  if (input.source !== 'manual' && shouldDedupe(signature)) return true;

  try {
    const { error } = await supabase.from('client_error_reports').insert({
      user_id: currentTags.userId,
      role: currentTags.role,
      label: input.label ?? null,
      route,
      message: input.message ?? null,
      component_stack: input.componentStack ?? null,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      context: {
        source: input.source,
        href: typeof window !== 'undefined' ? window.location.href : null,
        stack: input.stack ?? null,
        reported_at: new Date().toISOString(),
        ...(input.extra ?? {}),
      },
    });
    if (error) {
      console.warn('[errorReporting] insert failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[errorReporting] threw:', err);
    return false;
  }
}

let installed = false;
/**
 * Install global `window.onerror` + `unhandledrejection` listeners so that
 * errors outside any React tree (async callbacks, image loads, etc.) still
 * flow through the same pipeline.
 */
export function installGlobalErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  installChunkPreloadRecovery();

  window.addEventListener('error', (event) => {
    if (isIgnorableClientError(event.error ?? event.message, event.error?.stack ?? null, event.filename)) return;
    if (isAbortLike(event.error ?? event.message)) return;
    if (isAudioStartError(event.error ?? event.message)) { notifyAudioStartFailed(); return; }
    void reportClientError({
      source: 'window-onerror',
      message: event.message || String(event.error?.message ?? 'window error'),
      stack: event.error?.stack ?? null,
      extra: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (isIgnorableClientError(reason, reason instanceof Error ? reason.stack ?? null : null)) return;
    if (isAbortLike(reason)) { event.preventDefault(); return; }
    if (isAudioStartError(reason)) { event.preventDefault(); notifyAudioStartFailed(); return; }
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
    void reportClientError({
      source: 'unhandled-rejection',
      message,
      stack: reason instanceof Error ? reason.stack ?? null : null,
    });
  });
}