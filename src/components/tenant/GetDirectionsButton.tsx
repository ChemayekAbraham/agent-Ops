import { Navigation } from 'lucide-react';
import { useMapLinkAnnouncer } from '@/hooks/useMapLinkAnnouncer';

interface GetDirectionsButtonProps {
  lat: number | null | undefined;
  lng: number | null | undefined;
  title: string;
  /** compact = small pill for tight cards; full = full-width primary button */
  variant?: 'compact' | 'full';
  className?: string;
}

/**
 * Opens Google Maps in turn-by-turn **directions** mode (not just a pin), so a
 * tenant can tap a listed house and walk/drive straight to it using their phone
 * GPS — no need to call or message anyone first.
 *
 * Uses the universal Maps directions URL: on phones this hands off to the Google
 * Maps app and starts navigation from the user's current location.
 */
export function GetDirectionsButton({ lat, lng, title, variant = 'full', className = '' }: GetDirectionsButtonProps) {
  const announce = useMapLinkAnnouncer();
  if (lat == null || lng == null) return null;

  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

  if (variant === 'compact') {
    return (
      <a
        href={dirUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => { e.stopPropagation(); announce(title); }}
        aria-label={`Get directions to ${title} (opens Google Maps navigation)`}
        className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-[10px] transition-colors touch-manipulation active:scale-[0.97] shrink-0 ${className}`}
      >
        <Navigation className="h-3 w-3" />
        Directions
      </a>
    );
  }

  return (
    <a
      href={dirUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => { e.stopPropagation(); announce(title); }}
      aria-label={`Get directions to ${title} (opens Google Maps navigation)`}
      className={`flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm transition-colors touch-manipulation active:scale-[0.97] ${className}`}
    >
      <Navigation className="h-4 w-4" />
      Get Directions
    </a>
  );
}
