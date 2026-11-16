import { Suspense, lazy, useState } from 'react';
import { Check, Loader2, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { gpsFoundLine, type GpsFix } from '@/lib/gpsCapture';
import type { GpsCaptureState } from '@/hooks/useGpsCapture';

const PinDropMap = lazy(() => import('./PinDropMap'));

/**
 * The house GPS on both intake forms. One tap "Capture location": the in-app line, then the
 * browser's own prompt. The first reading is taken at once ("Location found (±60 m) ✓") and
 * improved in the background; no reading opens "Drop a pin on the house". Nothing here sends
 * the agent to the phone's settings, and the agent is never stuck.
 */
export function GpsCapturePanel({ gps, value, className }: {
  gps: GpsCaptureState;
  /** The GPS the form holds (a reading, a pin, or one from the house listing / on file). */
  value: GpsFix | { lat: number; lng: number; accuracy: number | null; source?: string } | null;
  className?: string;
}) {
  const [mapOpen, setMapOpen] = useState(false);
  const showMap = mapOpen || (gps.phase === 'pin' && !value);
  const fix: GpsFix | null = value ? { lat: value.lat, lng: value.lng, accuracy: value.accuracy ?? null, source: value.source === 'pin' ? 'pin' : 'gps' } : null;

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="gps-panel">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => gps.capture()}
          disabled={gps.phase === 'asking'}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-primary/40 bg-card px-4 text-sm font-semibold text-primary disabled:opacity-70"
        >
          {gps.phase === 'asking' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MapPin className="h-4 w-4" aria-hidden />}
          {fix ? 'Capture location again' : 'Capture location'}
        </button>
        {!fix && gps.phase !== 'asking' && (
          <button type="button" onClick={() => setMapOpen(true)} className="min-h-11 px-2 text-sm font-medium text-primary underline underline-offset-4">
            Drop a pin instead
          </button>
        )}
      </div>

      {gps.phase === 'asking' && (
        <p className="text-sm text-muted-foreground" role="status" data-testid="gps-asking">Welile needs your location to confirm the house.</p>
      )}
      {fix && gps.phase !== 'asking' && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-success" role="status" data-testid="gps-found">
          <Check className="h-4 w-4 shrink-0" aria-hidden />
          {gpsFoundLine(fix).replace(/ ✓$/, '')}
          {fix.source === 'pin' ? ' (accuracy unknown)' : ''} ✓
          {gps.phase === 'improving' && <span className="font-normal text-muted-foreground"> · improving…</span>}
        </p>
      )}
      {gps.phase === 'pin' && !fix && (
        <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="gps-pin-offer">
          <p className="font-semibold">Drop a pin on the house</p>
          <p className="text-muted-foreground">The phone didn’t give a location. Tap the house on the map instead.</p>
          <button type="button" onClick={() => setMapOpen(true)} className="min-h-11 self-start rounded-full bg-primary px-4 font-semibold text-primary-foreground">
            Open the map
          </button>
        </div>
      )}

      {showMap && (
        <Suspense fallback={<p className="text-sm text-muted-foreground" role="status">Opening the map…</p>}>
          <PinDropMap
            near={gps.location ? { lat: gps.location.lat, lng: gps.location.lng } : null}
            onPick={(lat, lng) => { setMapOpen(false); gps.dropPin(lat, lng); }}
            onCancel={() => setMapOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
