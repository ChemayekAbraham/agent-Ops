import { MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

type LocationFields = {
  agent_region?: string | null;
  agent_district?: string | null;
  agent_sub_county?: string | null;
  agent_parish?: string | null;
  agent_village?: string | null;
  agent_city?: string | null;
};

/**
 * Compact location chip for an agent advance request row.
 * Prefers most-specific → least-specific fields so reviewers can immediately
 * tell WHERE the agent is based when approving an advance.
 */
export function AgentLocationBadge({
  req,
  className,
  variant = 'chip',
}: {
  req: LocationFields;
  className?: string;
  variant?: 'chip' | 'row';
}) {
  const parts = [
    req.agent_village,
    req.agent_parish,
    req.agent_sub_county,
    req.agent_district,
    req.agent_region,
  ]
    .map((v) => (v ?? '').trim())
    .filter(Boolean);

  // Deduplicate consecutive repeats (e.g. district == region == "Wakiso").
  const seen = new Set<string>();
  const trail = parts.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const label = trail.length ? trail.join(', ') : (req.agent_city?.trim() || '');

  if (!label) {
    return (
      <div
        className={cn(
          'mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-amber-600',
          className,
        )}
      >
        <MapPin className="h-3 w-3" />
        Location not set
      </div>
    );
  }

  if (variant === 'row') {
    return (
      <div className={cn('flex items-start gap-1.5 text-[11px]', className)}>
        <MapPin className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
        <span className="font-medium text-foreground/90 leading-tight">{label}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mt-1 inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary max-w-full',
        className,
      )}
    >
      <MapPin className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}