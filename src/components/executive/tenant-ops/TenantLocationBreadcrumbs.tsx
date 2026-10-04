import { ChevronRight, Home, ArrowLeft } from 'lucide-react';
import type { TenantBreadcrumbPath } from '@/hooks/useTenantLocationBreakdown';

interface Props {
  path: TenantBreadcrumbPath;
  onJump: (path: TenantBreadcrumbPath) => void;
}

export function TenantLocationBreadcrumbs({ path, onJump }: Props) {
  const crumbs: Array<{ label: string; path: TenantBreadcrumbPath }> = [
    { label: 'All countries', path: {} },
  ];
  if (path.country)  crumbs.push({ label: path.country,  path: { country: path.country } });
  if (path.region)   crumbs.push({ label: path.region,   path: { country: path.country, region: path.region } });
  if (path.district) crumbs.push({ label: path.district, path: { country: path.country, region: path.region, district: path.district, districtId: path.districtId } });
  if (path.ward)     crumbs.push({ label: path.ward,     path: { country: path.country, region: path.region, district: path.district, districtId: path.districtId, ward: path.ward, subcountyId: path.subcountyId } });
  if (path.agentId !== undefined)  crumbs.push({ label: path.agentName ?? 'Agent',    path: { country: path.country, region: path.region, district: path.district, districtId: path.districtId, ward: path.ward, subcountyId: path.subcountyId, agentId: path.agentId, agentName: path.agentName } });
  if (path.landlordId !== undefined) crumbs.push({ label: path.landlordName ?? 'Landlord', path: { ...path } });

  const canGoBack = crumbs.length > 1;
  const parentPath = canGoBack ? crumbs[crumbs.length - 2].path : {};

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => onJump(parentPath)}
        disabled={!canGoBack}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition ${
          canGoBack
            ? 'bg-primary/10 text-primary hover:bg-primary/20'
            : 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
        }`}
        aria-label="Go back"
      >
        <ArrowLeft className="h-3 w-3" />
        Back
      </button>

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
    </div>
  );
}
