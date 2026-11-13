import { useCallback } from 'react';
import { Crosshair, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FunderNewLocationController } from '@/components/funder-new/useFunderNewLocation';

/**
 * The map's two round buttons, bottom-right: my location and full screen.
 * "My location" asks for (or refreshes) the device fix through the list's own
 * location controller; the map recentres when the fix arrives.
 */
export function FunderV3MapControls({
  location,
  fullscreen,
  onToggleFullscreen,
  onLocate,
}: {
  location: FunderNewLocationController;
  /** Tells the map to recentre on the device once the fix is in. */
  onLocate?: () => void;
  /** Omit onToggleFullscreen to hide that button (desktop split view). */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const device = location.coords;
  const locating = location.status === 'locating';
  const handleLocate = useCallback(() => {
    if (location.permission === 'denied') return;
    onLocate?.();
    if (device) location.refresh();
    else location.request();
  }, [device, location, onLocate]);

  const button =
    'pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full bg-card text-foreground shadow-[0_2px_8px_hsl(var(--foreground)/0.18)] ring-1 ring-border/50 transition-colors hover:bg-muted active:scale-95';

  return (
    <div className="pointer-events-none flex flex-col gap-2" data-testid="fv3-map-controls">
      {location.permission !== 'unsupported' ? (
        <button
          type="button"
          onClick={handleLocate}
          aria-label={device ? 'Recentre on my location' : 'Use my location'}
          data-testid="fv3-map-locate"
          className={button}
        >
          {locating ? <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden /> : <Crosshair className={cn('h-[18px] w-[18px]', device && 'text-primary')} aria-hidden />}
        </button>
      ) : null}
      {onToggleFullscreen ? (
        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? 'Close full screen map' : 'Open the map full screen'}
          aria-pressed={fullscreen}
          data-testid="fv3-map-fullscreen"
          className={button}
        >
          {fullscreen ? <Minimize2 className="h-[18px] w-[18px]" aria-hidden /> : <Maximize2 className="h-[18px] w-[18px]" aria-hidden />}
        </button>
      ) : null}
    </div>
  );
}

export default FunderV3MapControls;
