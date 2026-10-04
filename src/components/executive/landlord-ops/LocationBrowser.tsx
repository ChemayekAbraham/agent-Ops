import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { LocationSearchBar } from './LocationSearchBar';
import { LocationBreadcrumbs } from './LocationBreadcrumbs';
import { LocationTileGrid } from './LocationTileGrid';
import { PropertyLeafList } from './PropertyLeafList';
import {
  useLocationBreakdown,
  nextLevel,
  type BreadcrumbPath,
  type BreakdownRow,
} from '@/hooks/useLocationBreakdown';
import { PLANNED_MARKETS } from './plannedMarkets';
import { PlannedMarketTile } from './PlannedMarketTile';

export function LocationBrowser() {
  const [path, setPath] = useState<BreadcrumbPath>({});
  const level = nextLevel(path);
  const { data, isLoading } = useLocationBreakdown(path);

  const pick = (row: BreakdownRow) => {
    const p: BreadcrumbPath = { ...path };
    switch (level) {
      case 'country':  p.country  = row.label; break;
      case 'region':   p.region   = row.label; break;
      case 'district': p.district = row.label; p.districtId = row.district_id ?? null; break;
      case 'ward':     p.ward     = row.label; p.subcountyId = row.subcounty_id ?? null; break;
      case 'agent':    p.agentId  = row.agent_id ?? undefined; p.agentName = row.label; break;
      case 'landlord': p.landlordId = row.landlord_id ?? undefined; p.landlordName = row.label; break;
    }
    setPath(p);
  };

  const liveCountryNames = new Set((data ?? []).map(r => r.label.toLowerCase()));
  const plannedToShow = level === 'country'
    ? PLANNED_MARKETS.filter(m => !liveCountryNames.has(m.country.toLowerCase()))
    : [];

  return (
    <div className="space-y-3">
      <LocationSearchBar onPick={setPath} />
      <Card className="p-2.5 bg-muted/30">
        <LocationBreadcrumbs path={path} onJump={setPath} />
      </Card>
      {level === 'properties' ? (
        <PropertyLeafList path={path} />
      ) : (
        <>
          <LocationTileGrid
            rows={data ?? []}
            level={level}
            loading={isLoading}
            onPick={pick}
          />
          {plannedToShow.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                  Where we're going next
                </p>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {plannedToShow.map(m => <PlannedMarketTile key={m.country} market={m} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}