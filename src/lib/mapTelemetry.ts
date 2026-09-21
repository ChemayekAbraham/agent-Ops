/**
 * Production monitoring for the empty-house map.
 *
 * The in-memory `mapPerf` monitor answers "how is this session doing right
 * now". This module turns the same signals into a production-wide picture:
 * events are aggregated per region into a rolling window and posted as ONE row
 * per region per flush (default every 2 minutes, plus a final flush when the
 * tab is hidden). Idle sessions write nothing, so database volume stays flat
 * however many funders browse the map.
 */

import { supabase } from '@/integrations/supabase/client';

const FLUSH_INTERVAL_MS = 120_000;

interface RegionWindow {
  region: string;
  zoom: number;
  window_start: string;
  queries: number;
  cache_hits: number;
  failures: number;
  query_ms_sum: number;
  query_ms_max: number;
  renders: number;
  render_ms_sum: number;
  render_ms_max: number;
  houses_in_view_max: number;
  scan_capped_count: number;
  last_error: string | null;
}

const windows = new Map<string, RegionWindow>();
let timer: ReturnType<typeof setInterval> | null = null;
let listenersBound = false;
let currentRegion = 'unknown';
let currentZoom = 0;

const bucket = (region: string, zoom: number): RegionWindow => {
  const key = `${region}|${zoom}`;
  const existing = windows.get(key);
  if (existing) return existing;
  const fresh: RegionWindow = {
    region,
    zoom,
    window_start: new Date().toISOString(),
    queries: 0,
    cache_hits: 0,
    failures: 0,
    query_ms_sum: 0,
    query_ms_max: 0,
    renders: 0,
    render_ms_sum: 0,
    render_ms_max: 0,
    houses_in_view_max: 0,
    scan_capped_count: 0,
    last_error: null,
  };
  windows.set(key, fresh);
  return fresh;
};

const ensureScheduled = () => {
  if (typeof window === 'undefined') return;
  if (!timer) {
    timer = setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);
  }
  if (!listenersBound) {
    listenersBound = true;
    // A funder closing the tab is the common case — flush what we have.
    window.addEventListener('pagehide', () => void flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush();
    });
  }
};

/** Posts the collected windows and clears them. Failures are dropped silently. */
export async function flush(): Promise<void> {
  if (!windows.size) return;
  const batch = [...windows.values()];
  windows.clear();
  try {
    await supabase.rpc('record_map_query_telemetry', { p_batch: batch as never });
  } catch {
    // Telemetry must never disrupt browsing; drop the window on failure.
  }
}

export const mapTelemetry = {
  /** Called whenever the viewport moves, so later events are attributed correctly. */
  setContext(region: string, zoom: number) {
    currentRegion = region || 'unknown';
    currentZoom = Math.round(zoom ?? 0);
  },

  recordQuery(durationMs: number, info: { housesInView?: number; scanCapped?: boolean } = {}) {
    const w = bucket(currentRegion, currentZoom);
    w.queries += 1;
    w.query_ms_sum += durationMs;
    w.query_ms_max = Math.max(w.query_ms_max, durationMs);
    if (info.housesInView != null) w.houses_in_view_max = Math.max(w.houses_in_view_max, info.housesInView);
    if (info.scanCapped) w.scan_capped_count += 1;
    ensureScheduled();
  },

  recordCacheHit() {
    bucket(currentRegion, currentZoom).cache_hits += 1;
    ensureScheduled();
  },

  recordFailure(message: string) {
    const w = bucket(currentRegion, currentZoom);
    w.failures += 1;
    w.last_error = message.slice(0, 300);
    ensureScheduled();
  },

  recordRender(durationMs: number) {
    const w = bucket(currentRegion, currentZoom);
    w.renders += 1;
    w.render_ms_sum += durationMs;
    w.render_ms_max = Math.max(w.render_ms_max, durationMs);
    ensureScheduled();
  },

  flush,
};
