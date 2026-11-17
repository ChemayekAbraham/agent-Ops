import { Loader2, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GPS_IN_APP_LINE, gpsCapturedLine, gpsFailLine, systemBrowserUrl } from '@/lib/gpsCapture';
import type { GpsCaptureState } from '@/hooks/useGpsCapture';

/**
 * The house GPS on both intake forms. "Capture location" just captures and stores the
 * coordinates: "Location captured ✓ 0.34762, 32.58251 (±40 m)". No map. When it can't, one
 * short line says what to do: the site is blocked, there is no signal, or the page is open in
 * an app's own browser (then a button opens it in Chrome).
 */
export function GpsCapturePanel({ gps, value, className }: {
  gps: GpsCaptureState;
  /** The GPS the form holds (a reading, or one from the house listing / on file). */
  value: { lat: number; lng: number; accuracy: number | null } | null;
  className?: string;
}) {
  const href = typeof window !== 'undefined' ? window.location.href : '';
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="gps-panel">
      {gps.inAppBrowser && (
        <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="gps-in-app">
          <p className="font-medium">{GPS_IN_APP_LINE}</p>
          <a href={systemBrowserUrl(href)} target="_blank" rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center self-start rounded-full bg-primary px-4 font-semibold text-primary-foreground">
            Open in Chrome
          </a>
        </div>
      )}
      <button
        type="button"
        onClick={() => gps.capture()}
        disabled={gps.phase === 'asking'}
        className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-full border border-primary/40 bg-card px-4 text-sm font-semibold text-primary disabled:opacity-70"
      >
        {gps.phase === 'asking' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MapPin className="h-4 w-4" aria-hidden />}
        {value ? 'Capture location again' : 'Capture location'}
      </button>
      {value && gps.phase !== 'asking' && (
        <p className="text-sm font-medium text-success" role="status" data-testid="gps-captured">{gpsCapturedLine(value)}</p>
      )}
      {!value && gps.phase === 'failed' && gps.failure && (
        <p className="text-sm font-medium" role="alert" data-testid="gps-failure" data-code={gps.failure}>{gpsFailLine(gps.failure)}</p>
      )}
    </div>
  );
}
