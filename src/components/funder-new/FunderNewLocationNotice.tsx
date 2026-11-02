import { Loader2, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FunderNewLocationController } from './useFunderNewLocation';

export type FunderNewLocationNoticeState = 'prompt' | 'blocked' | null;

const DISMISSED_KEY = 'welile.funder-map.location-notice-dismissed';

/**
 * Which note, if any, the full screen map should show about location.
 *
 *  • prompt  — location has not been decided yet: explain why and offer the button
 *              (the browser's own permission prompt only opens from that tap)
 *  • blocked — the browser has location turned off: the app cannot re-ask, so it
 *              says where to turn it back on
 *  • null    — already allowed, in use, unsupported, or put away for this visit
 */
export function locationNoticeState(
  location: Pick<FunderNewLocationController, 'permission' | 'coords'>,
  dismissed: boolean,
): FunderNewLocationNoticeState {
  if (dismissed || location.coords) return null;
  if (location.permission === 'prompt' || location.permission === 'unknown') return 'prompt';
  if (location.permission === 'denied') return 'blocked';
  return null;
}

/** "Not now" is remembered for this visit only. It is a flag, never a position. */
export function readLocationNoticeDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLocationNoticeDismissed() {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* private mode: the note simply returns next time */
  }
}

export function FunderNewLocationNotice({
  state,
  locating,
  onAllow,
  onDismiss,
}: {
  state: Exclude<FunderNewLocationNoticeState, null>;
  locating: boolean;
  onAllow: () => void;
  onDismiss: () => void;
}) {
  if (state === 'blocked') {
    return (
      <div
        role="status"
        className="pointer-events-auto flex items-start gap-2 rounded-2xl bg-card px-3 py-2.5 text-xs text-muted-foreground shadow-lg ring-1 ring-black/5"
      >
        <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 leading-snug">
          Location is off. Turn it on in your browser settings to see houses near you.
        </p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-muted"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Use your location"
      className="pointer-events-auto rounded-2xl bg-card p-3 shadow-lg ring-1 ring-black/5"
    >
      <div className="flex items-start gap-2">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">Show houses near you</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            Allow location and the closest homes load first.
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" className="h-9 rounded-full px-4" onClick={onAllow} disabled={locating}>
          {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MapPin className="h-4 w-4" aria-hidden />}
          {locating ? 'Finding you…' : 'Use my location'}
        </Button>
        <Button size="sm" variant="ghost" className="h-9 rounded-full px-3" onClick={onDismiss} disabled={locating}>
          Not now
        </Button>
      </div>
    </div>
  );
}
