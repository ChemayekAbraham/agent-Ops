import { useEffect, useState } from 'react';
import { isMapPerfOverlayEnabled, mapPerf, type MapPerfSnapshot } from '@/lib/mapPerf';

/**
 * Opt-in performance readout for the empty-house map: viewport query latency,
 * marker rendering time, cache hit rate and failed requests. Enable with
 * `?mapPerf=1` (disable with `?mapPerf=0`). Renders nothing otherwise.
 */
export function MapPerfOverlay() {
  const [enabled] = useState(() => isMapPerfOverlayEnabled());
  const [snapshot, setSnapshot] = useState<MapPerfSnapshot>(() => mapPerf.snapshot());

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = mapPerf.subscribe(() => setSnapshot(mapPerf.snapshot()));
    return () => {
      unsubscribe();
    };
  }, [enabled]);

  if (!enabled) return null;

  const ms = (value: number | null) => (value == null ? '—' : `${value} ms`);

  return (
    <div
      className="pointer-events-auto absolute bottom-3 left-3 z-[1000] w-56 rounded-lg border border-border/60 bg-background/95 p-3 text-[11px] leading-relaxed shadow-lg backdrop-blur"
      role="status"
      aria-label="Map performance monitor"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">Map performance</span>
        <button type="button" className="text-muted-foreground underline" onClick={() => mapPerf.reset()}>
          reset
        </button>
      </div>
      <dl className="space-y-0.5">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Query (last / avg)</dt>
          <dd className="font-medium">{ms(snapshot.queryMsLast)} / {ms(snapshot.queryMsAvg)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Query p95 / max</dt>
          <dd className="font-medium">{ms(snapshot.queryMsP95)} / {ms(snapshot.queryMsMax)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Markers render</dt>
          <dd className="font-medium">{ms(snapshot.renderMsLast)} / {ms(snapshot.renderMsAvg)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Cache hit rate</dt>
          <dd className="font-medium">
            {Math.round(snapshot.cacheHitRate * 100)}% ({snapshot.cacheHits}/{snapshot.cacheHits + snapshot.queries})
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Markers / in view</dt>
          <dd className="font-medium">{snapshot.markersLast} / {snapshot.housesInViewLast}{snapshot.scanCappedLast ? '+' : ''}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Failed requests</dt>
          <dd className={snapshot.failures > 0 ? 'font-semibold text-destructive' : 'font-medium'}>{snapshot.failures}</dd>
        </div>
      </dl>
      {snapshot.lastError && <p className="mt-1 truncate text-destructive" title={snapshot.lastError}>{snapshot.lastError}</p>}
    </div>
  );
}
