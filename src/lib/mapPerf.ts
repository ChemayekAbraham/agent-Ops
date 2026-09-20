/**
 * Lightweight, in-memory performance monitor for the empty-house map.
 *
 * Tracks four signals over a rolling window: viewport query latency, marker
 * rendering time, cache hit rate, and failed requests. Everything stays on the
 * client — no database writes, no network calls — so it is safe to keep on in
 * production. The optional on-map overlay reads the same snapshot.
 */

import { mapTelemetry } from './mapTelemetry';

const WINDOW = 50;

export interface MapPerfSnapshot {
  /** Viewport queries that went to the database. */
  queries: number;
  /** Viewport reads served from the React Query cache (no request). */
  cacheHits: number;
  /** cacheHits / (cacheHits + queries), 0-1. */
  cacheHitRate: number;
  failures: number;
  lastError: string | null;
  queryMsLast: number | null;
  queryMsAvg: number | null;
  queryMsP95: number | null;
  queryMsMax: number | null;
  renderMsLast: number | null;
  renderMsAvg: number | null;
  renderMsMax: number | null;
  markersLast: number;
  housesInViewLast: number;
  scanCappedLast: boolean;
}

const queryMs: number[] = [];
const renderMs: number[] = [];
const seenKeys = new Set<string>();

let queries = 0;
let cacheHits = 0;
let failures = 0;
let lastError: string | null = null;
let markersLast = 0;
let housesInViewLast = 0;
let scanCappedLast = false;

const listeners = new Set<() => void>();
const push = (bucket: number[], value: number) => {
  bucket.push(value);
  if (bucket.length > WINDOW) bucket.shift();
};
const avg = (bucket: number[]) =>
  bucket.length ? Math.round((bucket.reduce((a, b) => a + b, 0) / bucket.length) * 10) / 10 : null;
const percentile = (bucket: number[], p: number) => {
  if (!bucket.length) return null;
  const sorted = [...bucket].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
};
const emit = () => listeners.forEach((fn) => fn());

export const mapPerf = {
  /** A viewport query that hit the database. */
  recordQuery(durationMs: number, info: { markers?: number; housesInView?: number; scanCapped?: boolean } = {}) {
    queries += 1;
    push(queryMs, durationMs);
    if (info.markers != null) markersLast = info.markers;
    if (info.housesInView != null) housesInViewLast = info.housesInView;
    if (info.scanCapped != null) scanCappedLast = info.scanCapped;
    emit();
  },

  /** A viewport the funder returned to, served from cache without a request. */
  recordCacheHit() {
    cacheHits += 1;
    emit();
  },

  /**
   * Classifies a viewport key: repeated keys are cache hits, new keys will be
   * fetched. Returns true when the key had already been requested.
   */
  noteViewportKey(key: string) {
    if (seenKeys.has(key)) {
      mapPerf.recordCacheHit();
      return true;
    }
    seenKeys.add(key);
    if (seenKeys.size > 500) seenKeys.delete(seenKeys.values().next().value as string);
    return false;
  },

  recordFailure(message: string) {
    failures += 1;
    lastError = message;
    emit();
  },

  /** Time spent building and committing the map markers. */
  recordRender(durationMs: number, markers: number) {
    push(renderMs, durationMs);
    markersLast = markers;
    emit();
  },

  snapshot(): MapPerfSnapshot {
    const reads = queries + cacheHits;
    return {
      queries,
      cacheHits,
      cacheHitRate: reads ? cacheHits / reads : 0,
      failures,
      lastError,
      queryMsLast: queryMs.length ? Math.round(queryMs[queryMs.length - 1] * 10) / 10 : null,
      queryMsAvg: avg(queryMs),
      queryMsP95: percentile(queryMs, 0.95),
      queryMsMax: queryMs.length ? Math.round(Math.max(...queryMs) * 10) / 10 : null,
      renderMsLast: renderMs.length ? Math.round(renderMs[renderMs.length - 1] * 10) / 10 : null,
      renderMsAvg: avg(renderMs),
      renderMsMax: renderMs.length ? Math.round(Math.max(...renderMs) * 10) / 10 : null,
      markersLast,
      housesInViewLast,
      scanCappedLast,
    };
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  reset() {
    queryMs.length = 0;
    renderMs.length = 0;
    seenKeys.clear();
    queries = 0;
    cacheHits = 0;
    failures = 0;
    lastError = null;
    markersLast = 0;
    housesInViewLast = 0;
    scanCappedLast = false;
    emit();
  },
};

/** Overlay is opt-in: `?mapPerf=1` in the URL, or localStorage `welile-map-perf=1`. */
export const isMapPerfOverlayEnabled = () => {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mapPerf') === '1') {
      window.localStorage.setItem('welile-map-perf', '1');
      return true;
    }
    if (params.get('mapPerf') === '0') {
      window.localStorage.removeItem('welile-map-perf');
      return false;
    }
    return window.localStorage.getItem('welile-map-perf') === '1';
  } catch {
    return false;
  }
};
