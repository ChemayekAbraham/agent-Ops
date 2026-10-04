import { ChevronRight, Home } from 'lucide-react';
import type { BreadcrumbPath } from '@/hooks/useLocationBreakdown';

interface Props {
  path: BreadcrumbPath;
  onJump: (path: BreadcrumbPath) => void;
}

export function LocationBreadcrumbs({ path, onJump }: Props) {
  const crumbs: Array<{ label: string; path: BreadcrumbPath }> = [
    { label: 'All countries', path: {} },
  ];
  if (path.country) crumbs.push({ label: path.country, path: { country: path.country } });
  if (path.region) crumbs.push({ label: path.region, path: { country: path.country, region: path.region } });
  if (path.district) crumbs.push({ label: path.district, path: { ...path, ward: undefined, subcountyId: undefined, agentId: undefined, landlordId: undefined } });
  if (path.ward) crumbs.push({ label: path.ward, path: { ...path, agentId: undefined, landlordId: undefined } });
  if (path.agentId) crumbs.push({ label: path.agentName ?? 'Agent', path: { ...path, landlordId: undefined } });
  if (path.landlordId) crumbs.push({ label: path.landlordName ?? 'Landlord', path: { ...path } });

  return (
    <nav aria-label="Location" className="flex items-center gap-1 flex-wrap text-xs">
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            {i === 0 && <Home className="h-3 w-3 text-muted-foreground" />}
            <button
              onClick={() => !isLast && onJump(c.path)}
              disabled={isLast}
              className={isLast
                ? 'font-semibold text-foreground cursor-default'
                : 'text-primary hover:underline'}
            >
              {c.label}
            </button>
            {!isLast && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </span>
        );
      })}
    </nav>
  );
}