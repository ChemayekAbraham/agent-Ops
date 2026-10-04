import { MapPin, Navigation } from 'lucide-react';

/**
 * GPS chip shown on every partner rent-plan card. Renders the recorded
 * coordinates of the property and opens Google Maps on tap. When the agent
 * never captured a fix, it says so plainly instead of hiding the row.
 */
export function PlanGpsChip({
  latitude,
  longitude,
  className = '',
}: {
  latitude?: number | string | null;
  longitude?: number | string | null;
  className?: string;
}) {
  const lat = latitude == null ? null : Number(latitude);
  const lng = longitude == null ? null : Number(longitude);
  const hasFix = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng);

  if (!hasFix) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground ${className}`}
      >
        <MapPin className="h-3 w-3 shrink-0" />
        GPS not captured
      </span>
    );
  }

  const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${coords} in Google Maps`}
      className={`inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary ${className}`}
    >
      <Navigation className="h-3 w-3 shrink-0" />
      <span className="truncate">{coords}</span>
    </a>
  );
}