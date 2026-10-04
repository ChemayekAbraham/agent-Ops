/**
 * Runtime polyfill GATE — conditional, per-API targeted loader.
 *
 * Vite `target: es2015` only down-levels modern *syntax* — it does NOT add
 * polyfills for newer *runtime methods*. Several shipped dependencies use
 * ES2016–2023 methods that crash the whole app with a blank screen on phones
 * that lack them.
 *
 * Instead of one monolithic polyfill bundle, each API is mapped to its own tiny
 * async chunk (`./polyfills/*`). This gate runs a synchronous feature-detection
 * pass and dynamically imports ONLY the chunks whose APIs are actually missing
 * on the current device. Effects:
 *   - Modern phones:      every probe passes, nothing is fetched, zero cost.
 *   - Slightly-old phones: fetch just the one or two chunks they need — so more
 *                          devices boot successfully and never see the
 *                          out-of-date warning banner.
 *
 * Callers MUST await `ensureRuntimePolyfills()` before loading any app code so
 * the patches are in place first.
 */
import { clientLog } from './clientLogger';

type Loader = () => Promise<unknown>;

interface PolyfillProbe {
  /** Human-readable feature name (for logs + telemetry). */
  name: string;
  /** Stable chunk label — probes that share a chunk are de-duped by this. */
  chunk: string;
  /** Returns true when the feature IS present (no polyfill needed). */
  test: () => boolean;
  /** Targeted chunk loader — Vite emits each as its own async chunk. */
  load: Loader;
}

/**
 * The probe registry. Multiple probes may point at the same chunk (e.g. both
 * `Array.prototype.at` and `String.prototype.at` live in the `at` chunk); the
 * gate loads each chunk at most once.
 */
const PROBES: PolyfillProbe[] = [
  { name: 'String.prototype.replaceAll', chunk: 'string-replaceall',
    test: () => typeof (String.prototype as any).replaceAll === 'function',
    load: () => import('./polyfills/string-replaceall') },

  { name: 'Array.prototype.at', chunk: 'at',
    test: () => typeof (Array.prototype as any).at === 'function',
    load: () => import('./polyfills/at') },
  { name: 'String.prototype.at', chunk: 'at',
    test: () => typeof (String.prototype as any).at === 'function',
    load: () => import('./polyfills/at') },

  { name: 'Object.hasOwn', chunk: 'object-hasown',
    test: () => typeof (Object as any).hasOwn === 'function',
    load: () => import('./polyfills/object-hasown') },

  { name: 'Array.prototype.flat', chunk: 'array-flat',
    test: () => typeof (Array.prototype as any).flat === 'function',
    load: () => import('./polyfills/array-flat') },
  { name: 'Array.prototype.flatMap', chunk: 'array-flat',
    test: () => typeof (Array.prototype as any).flatMap === 'function',
    load: () => import('./polyfills/array-flat') },

  { name: 'Promise.allSettled', chunk: 'promise-allsettled',
    test: () => typeof (Promise as any).allSettled === 'function',
    load: () => import('./polyfills/promise-allsettled') },
  { name: 'Promise.any', chunk: 'promise-any',
    test: () => typeof (Promise as any).any === 'function',
    load: () => import('./polyfills/promise-any') },

  { name: 'globalThis', chunk: 'globalthis',
    test: () => typeof (globalThis as any) !== 'undefined',
    load: () => import('./polyfills/globalthis') },

  // --- Newly detected APIs, each mapped to its own targeted chunk ---
  { name: 'Object.fromEntries', chunk: 'object-fromentries',
    test: () => typeof (Object as any).fromEntries === 'function',
    load: () => import('./polyfills/object-fromentries') },

  { name: 'Object.entries', chunk: 'object-entries-values',
    test: () => typeof (Object as any).entries === 'function',
    load: () => import('./polyfills/object-entries-values') },
  { name: 'Object.values', chunk: 'object-entries-values',
    test: () => typeof (Object as any).values === 'function',
    load: () => import('./polyfills/object-entries-values') },

  { name: 'Array.prototype.includes', chunk: 'array-includes',
    test: () => typeof (Array.prototype as any).includes === 'function',
    load: () => import('./polyfills/array-includes') },

  { name: 'Array.prototype.findLast', chunk: 'array-findlast',
    test: () => typeof (Array.prototype as any).findLast === 'function',
    load: () => import('./polyfills/array-findlast') },
  { name: 'Array.prototype.findLastIndex', chunk: 'array-findlast',
    test: () => typeof (Array.prototype as any).findLastIndex === 'function',
    load: () => import('./polyfills/array-findlast') },

  { name: 'String.prototype.matchAll', chunk: 'string-matchall',
    test: () => typeof (String.prototype as any).matchAll === 'function',
    load: () => import('./polyfills/string-matchall') },

  { name: 'String.prototype.trimStart', chunk: 'string-trim',
    test: () => typeof (String.prototype as any).trimStart === 'function',
    load: () => import('./polyfills/string-trim') },
  { name: 'String.prototype.trimEnd', chunk: 'string-trim',
    test: () => typeof (String.prototype as any).trimEnd === 'function',
    load: () => import('./polyfills/string-trim') },

  { name: 'String.prototype.padStart', chunk: 'string-pad',
    test: () => typeof (String.prototype as any).padStart === 'function',
    load: () => import('./polyfills/string-pad') },
  { name: 'String.prototype.padEnd', chunk: 'string-pad',
    test: () => typeof (String.prototype as any).padEnd === 'function',
    load: () => import('./polyfills/string-pad') },

  { name: 'Number.isInteger', chunk: 'number-checks',
    test: () => typeof (Number as any).isInteger === 'function',
    load: () => import('./polyfills/number-checks') },
  { name: 'Number.isFinite', chunk: 'number-checks',
    test: () => typeof (Number as any).isFinite === 'function',
    load: () => import('./polyfills/number-checks') },
  { name: 'Number.isNaN', chunk: 'number-checks',
    test: () => typeof (Number as any).isNaN === 'function',
    load: () => import('./polyfills/number-checks') },

  { name: 'structuredClone', chunk: 'structured-clone',
    test: () => typeof (globalThis as any).structuredClone === 'function',
    load: () => import('./polyfills/structured-clone') },
];

interface MissingResult {
  features: string[];
  chunks: Map<string, Loader>;
}

/** Run all probes; return missing feature names + the unique chunks to load. */
function detectMissing(): MissingResult {
  const features: string[] = [];
  const chunks = new Map<string, Loader>();
  for (const probe of PROBES) {
    let ok = false;
    try { ok = probe.test() === true; } catch { ok = false; }
    if (!ok) {
      features.push(probe.name);
      if (!chunks.has(probe.chunk)) chunks.set(probe.chunk, probe.load);
    }
  }
  return { features, chunks };
}

function reportCompat(
  event: 'gate_missing' | 'impl_loaded' | 'impl_load_failed',
  fields: { features?: string[]; load_ms?: number; error_message?: string },
) {
  void import('./compatTelemetry')
    .then(({ reportCompatEvent }) =>
      reportCompatEvent({
        event_type: event,
        missing_features: fields.features,
        load_ms: fields.load_ms ?? null,
        error_message: fields.error_message ?? null,
      }),
    )
    .catch(() => {});
}

let applied: Promise<void> | null = null;

/**
 * Ensure runtime polyfills are applied. Resolves immediately (no fetch) on
 * modern devices; fetches + applies only the targeted chunks a device is
 * missing. Never throws — a failed polyfill fetch must not block app startup.
 */
export function ensureRuntimePolyfills(): Promise<void> {
  if (applied) return applied;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : null;

  let result: MissingResult;
  try {
    result = detectMissing();
  } catch {
    // Detection itself threw on an ancient engine — load everything as a
    // last-ditch effort so the app still has a chance to boot.
    const chunks = new Map<string, Loader>();
    for (const p of PROBES) if (!chunks.has(p.chunk)) chunks.set(p.chunk, p.load);
    result = { features: ['detection-threw'], chunks };
  }

  const { features: missing, chunks } = result;

  if (missing.length === 0) {
    applied = Promise.resolve();
    return applied;
  }

  // Record which features are missing + which targeted chunks we will fetch.
  const chunkNames = Array.from(chunks.keys());
  clientLog.warn('polyfill.gate.missing_features', {
    missing_features: missing,
    missing_count: missing.length,
    chunks: chunkNames,
    chunk_count: chunkNames.length,
    user_agent: ua,
  });
  reportCompat('gate_missing', { features: missing });

  const startedAt = Date.now();
  applied = Promise.allSettled(
    Array.from(chunks.entries()).map(([chunk, load]) =>
      load().then(
        () => ({ chunk, ok: true as const }),
        (err) => ({ chunk, ok: false as const, err }),
      ),
    ),
  ).then((results) => {
    const settled = results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { chunk: 'unknown', ok: false as const, err: r.reason },
    );
    const loaded = settled.filter((s) => s.ok).map((s) => s.chunk);
    const failed = settled.filter((s) => !s.ok) as Array<{ chunk: string; err: unknown }>;
    const load_ms = Date.now() - startedAt;

    if (loaded.length > 0) {
      clientLog.info('polyfill.impl.loaded', { chunks: loaded, load_ms });
      reportCompat('impl_loaded', { features: loaded, load_ms });
    }

    if (failed.length > 0) {
      const firstErr = failed[0].err;
      clientLog.error('polyfill.impl.load_failed', {
        failed_chunks: failed.map((f) => f.chunk),
        missing_features: missing,
        user_agent: ua,
        load_ms,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        error_message: firstErr instanceof Error ? firstErr.message : String(firstErr),
        error_stack: firstErr instanceof Error ? firstErr.stack ?? null : null,
        // Raw Error so clientLog forwards it to Sentry.captureException.
        error: firstErr,
      });
      reportCompat('impl_load_failed', {
        features: failed.map((f) => f.chunk),
        load_ms,
        error_message: firstErr instanceof Error ? firstErr.message : String(firstErr),
      });
    }
  });

  return applied;
}
