import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * GPS quality indicator — a compact colored-dot + accuracy badge for audit
 * rows so operators can scan a list and instantly spot which captures are
 * usable for on-site verification.
 *
 * Buckets are tuned for urban field-ops in Uganda:
 *   ≤25 m   high     (green)  building-level, trustworthy
 *   ≤100 m  medium   (amber)  block-level, usable with care
 *   >100 m  low      (red)    area-only, cross-check before relying on it
 *
 * Renders nothing if there are no coordinates — capture-status pills already
 * cover the "no geo" case, so we don't want to double up.
 */
export interface GpsQualityIndicatorProps {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  accuracy: number | null | undefined;
  /** Hide the textual label, keep the dot + numeric accuracy only. */
  compact?: boolean;
  className?: string;
}

type Tier = {
  label: string;
  dot: string;
  cls: string;
};

function classify(accuracy: number | null): Tier {
  if (accuracy == null) {
    return {
      label: 'No accuracy',
      dot: 'bg-muted-foreground',
      cls: 'bg-muted text-muted-foreground border-border',
    };
  }
  if (accuracy <= 25) {
    return {
      label: 'High',
      dot: 'bg-emerald-500',
      cls: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
    };
  }
  if (accuracy <= 100) {
    return {
      label: 'Medium',
      dot: 'bg-amber-500',
      cls: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
    };
  }
  return {
    label: 'Low',
    dot: 'bg-destructive',
    cls: 'bg-destructive/10 text-destructive border-destructive/30',
  };
}

export function GpsQualityIndicator({
  latitude,
  longitude,
  accuracy,
  compact = false,
  className,
}: GpsQualityIndicatorProps) {
  const hasCoords = latitude != null && longitude != null;
  if (!hasCoords) return null;

  const acc = accuracy == null ? null : Number(accuracy);
  const tier = classify(acc);
  const accText = acc == null ? '—' : `±${Math.round(acc)} m`;

  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 text-[10px] font-medium', tier.cls, className)}
      title={
        acc == null
          ? 'Coordinates recorded without an accuracy reading'
          : `Reported GPS accuracy radius: ±${Math.round(acc)} m (${tier.label.toLowerCase()} quality)`
      }
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', tier.dot)} />
      {compact ? accText : `${tier.label} · ${accText}`}
    </Badge>
  );
}

export default GpsQualityIndicator;