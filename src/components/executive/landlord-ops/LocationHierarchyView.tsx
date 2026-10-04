import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ChevronDown, ChevronRight, Globe2, MapPin, Map as MapIcon,
  UserCog, Building2, Home,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { normalizeUgandaRegion, normalizeDistrict } from '@/lib/ugandaDistricts';

export interface HierarchyHouse {
  id: string;
  title: string;
  address: string;
  region: string;
  district?: string | null;
  status: string;
  monthly_rent: number;
  daily_rate: number;
  agent_id: string;
  landlord_id: string | null;
  tenant_id: string | null;
  is_hidden: boolean;
}

interface Props {
  houses: HierarchyHouse[];
  profiles: Record<string, { name: string; phone: string | null }>;
  country?: string;
}

type Counts = { total: number; occupied: number; vacant: number };
const mergeCounts = (a: Counts, h: HierarchyHouse): Counts => ({
  total: a.total + 1,
  occupied: a.occupied + (h.tenant_id ? 1 : 0),
  vacant: a.vacant + (h.tenant_id ? 0 : 1),
});
const emptyCounts: Counts = { total: 0, occupied: 0, vacant: 0 };

function CountsPills({ c }: { c: Counts }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
      <span>{c.total} house{c.total === 1 ? '' : 's'}</span>
      <span className="text-success">· {c.occupied} occ</span>
      <span className="text-amber-600">· {c.vacant} vac</span>
    </div>
  );
}

function Row({
  open, onToggle, icon, title, subtitle, counts, depth,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  counts: Counts;
  depth: number;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full text-left flex items-center gap-2 px-2 py-2 rounded-md hover:bg-muted/50 active:bg-muted transition-colors min-h-[44px]"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="text-sm font-semibold truncate block">{title}</span>
        {subtitle && <span className="text-[11px] text-muted-foreground truncate block">{subtitle}</span>}
      </span>
      <CountsPills c={counts} />
    </button>
  );
}

export function LocationHierarchyView({ houses, profiles, country = 'Uganda' }: Props) {
  // Build tree: region → district → agent → landlord → houses[]
  const tree = useMemo(() => {
    const root = new Map<string, Map<string, Map<string, Map<string, HierarchyHouse[]>>>>();
    for (const h of houses) {
      // Roll up legacy/mis-bucketed values: e.g. region="Kampala" really
      // belongs to "Central" region with district="Kampala".
      const rawRegion = h.region?.trim() || '';
      const rawDistrict = h.district?.trim() || '';
      const region = country === 'Uganda'
        ? normalizeUgandaRegion(rawRegion || rawDistrict)
        : (rawRegion || 'Unknown region');
      const districtCandidate = rawDistrict
        || (rawRegion && normalizeUgandaRegion(rawRegion) !== rawRegion ? rawRegion : '');
      const district = country === 'Uganda'
        ? (normalizeDistrict(districtCandidate) || 'Unknown district')
        : (rawDistrict || 'Unknown district');
      const agentId = h.agent_id || 'unknown-agent';
      const landlordId = h.landlord_id || 'unknown-landlord';
      if (!root.has(region)) root.set(region, new Map());
      const r = root.get(region)!;
      if (!r.has(district)) r.set(district, new Map());
      const d = r.get(district)!;
      if (!d.has(agentId)) d.set(agentId, new Map());
      const a = d.get(agentId)!;
      if (!a.has(landlordId)) a.set(landlordId, []);
      a.get(landlordId)!.push(h);
    }
    return root;
  }, [houses]);

  const totals = useMemo(() => houses.reduce(mergeCounts, emptyCounts), [houses]);

  const [open, setOpen] = useState<Record<string, boolean>>({ [`country:${country}`]: true });
  const toggle = (k: string) => setOpen(s => ({ ...s, [k]: !s[k] }));

  const countryOpen = !!open[`country:${country}`];

  if (houses.length === 0) {
    return <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No houses to drill into.</CardContent></Card>;
  }

  return (
    <Card>
      <CardContent className="p-2">
        <Row
          open={countryOpen}
          onToggle={() => toggle(`country:${country}`)}
          icon={<Globe2 className="h-4 w-4 text-primary" />}
          title={country}
          counts={totals}
          depth={0}
        />
        {countryOpen && (
          <div className="space-y-0.5">
            {Array.from(tree.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([region, districts]) => {
                const regionKey = `r:${region}`;
                const regionHouses = Array.from(districts.values()).flatMap(d =>
                  Array.from(d.values()).flatMap(a => Array.from(a.values()).flat())
                );
                const regionCounts = regionHouses.reduce(mergeCounts, emptyCounts);
                const isOpen = !!open[regionKey];
                return (
                  <div key={regionKey}>
                    <Row
                      open={isOpen}
                      onToggle={() => toggle(regionKey)}
                      icon={<MapPin className="h-4 w-4 text-sky-600" />}
                      title={region}
                      counts={regionCounts}
                      depth={1}
                    />
                    {isOpen && Array.from(districts.entries())
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([district, agents]) => {
                        const dKey = `${regionKey}|d:${district}`;
                        const dHouses = Array.from(agents.values()).flatMap(a => Array.from(a.values()).flat());
                        const dCounts = dHouses.reduce(mergeCounts, emptyCounts);
                        const dOpen = !!open[dKey];
                        return (
                          <div key={dKey}>
                            <Row
                              open={dOpen}
                              onToggle={() => toggle(dKey)}
                              icon={<MapIcon className="h-4 w-4 text-indigo-600" />}
                              title={district}
                              counts={dCounts}
                              depth={2}
                            />
                            {dOpen && Array.from(agents.entries())
                              .sort(([a], [b]) => (profiles[a]?.name ?? '').localeCompare(profiles[b]?.name ?? ''))
                              .map(([agentId, landlords]) => {
                                const aKey = `${dKey}|a:${agentId}`;
                                const aHouses = Array.from(landlords.values()).flat();
                                const aCounts = aHouses.reduce(mergeCounts, emptyCounts);
                                const aOpen = !!open[aKey];
                                const ap = profiles[agentId];
                                return (
                                  <div key={aKey}>
                                    <Row
                                      open={aOpen}
                                      onToggle={() => toggle(aKey)}
                                      icon={<UserCog className="h-4 w-4 text-purple-600" />}
                                      title={ap?.name ?? 'Unknown agent'}
                                      subtitle={ap?.phone ?? undefined}
                                      counts={aCounts}
                                      depth={3}
                                    />
                                    {aOpen && Array.from(landlords.entries())
                                      .sort(([a], [b]) => (profiles[a]?.name ?? '').localeCompare(profiles[b]?.name ?? ''))
                                      .map(([landlordId, lHouses]) => {
                                        const lKey = `${aKey}|l:${landlordId}`;
                                        const lCounts = lHouses.reduce(mergeCounts, emptyCounts);
                                        const lOpen = !!open[lKey];
                                        const lp = profiles[landlordId];
                                        return (
                                          <div key={lKey}>
                                            <Row
                                              open={lOpen}
                                              onToggle={() => toggle(lKey)}
                                              icon={<Building2 className="h-4 w-4 text-amber-600" />}
                                              title={lp?.name ?? 'Unknown landlord'}
                                              subtitle={lp?.phone ?? undefined}
                                              counts={lCounts}
                                              depth={4}
                                            />
                                            {lOpen && (
                                              <div className="space-y-1 py-1" style={{ paddingLeft: 8 + 5 * 12 }}>
                                                {lHouses
                                                  .slice()
                                                  .sort((x, y) => x.title.localeCompare(y.title))
                                                  .map(h => (
                                                    <div key={h.id} className="rounded-md border bg-background p-2 flex items-start gap-2">
                                                      <Home className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
                                                      <div className="min-w-0 flex-1">
                                                        <p className="text-sm font-medium truncate">{h.title}</p>
                                                        <p className="text-[11px] text-muted-foreground truncate">{h.address}</p>
                                                        <p className="text-[11px] text-muted-foreground">
                                                          {formatUGX(h.monthly_rent)}/mo · {formatUGX(h.daily_rate)}/day
                                                        </p>
                                                      </div>
                                                      <div className="flex flex-col items-end gap-1 shrink-0">
                                                        <Badge variant={h.tenant_id ? 'default' : 'outline'} className="text-[10px]">
                                                          {h.tenant_id ? 'Occupied' : 'Vacant'}
                                                        </Badge>
                                                        {h.is_hidden && (
                                                          <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-800 border-amber-200">
                                                            Hidden
                                                          </Badge>
                                                        )}
                                                      </div>
                                                    </div>
                                                  ))}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                  </div>
                                );
                              })}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}