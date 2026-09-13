/**
 * Geographic navigator for the landlord verification queue.
 *
 * Read-only presentation over the rows the panel already loaded: it groups the
 * queue by the location recorded on each landlord
 * (Country -> Region -> District -> County -> Sub-county -> Village/Cell -> landlord)
 * and reports the chosen path back so the queue below filters to it. Recorded
 * location text is never rewritten; blanks are grouped as "Not recorded".
 */
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronRight, MapPin, Navigation, Phone, UserCircle, Globe } from 'lucide-react';

export interface LandlordGeo {
  country: string | null;
  region: string | null;
  district: string | null;
  county: string | null;
  sub_county: string | null;
  town_council: string | null;
  village: string | null;
  cell: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface GeoQueueRow {
  landlord_id: string;
  landlord_name: string | null;
  landlord_phone: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  status: string;
  geo: LandlordGeo | null;
}

export interface GeoPath {
  country?: string;
  region?: string;
  district?: string;
  county?: string;
  subcounty?: string;
  village?: string;
  landlordId?: string;
}

const UNRECORDED = 'Not recorded';

const LEVELS = ['country', 'region', 'district', 'county', 'subcounty', 'village'] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_LABEL: Record<Level, string> = {
  country: 'Country',
  region: 'Region',
  district: 'District',
  county: 'County',
  subcounty: 'Sub-county',
  village: 'Village / Cell',
};

const clean = (v: string | null | undefined) => (v || '').trim();

/** The value recorded for a row at a given level, or "Not recorded". */
export function geoValueAt(geo: LandlordGeo | null, level: Level): string {
  if (!geo) return UNRECORDED;
  switch (level) {
    case 'country':
      return clean(geo.country) || 'Uganda';
    case 'region':
      return clean(geo.region) || UNRECORDED;
    case 'district':
      return clean(geo.district) || UNRECORDED;
    case 'county':
      return clean(geo.county) || UNRECORDED;
    case 'subcounty':
      return clean(geo.town_council) || clean(geo.sub_county) || UNRECORDED;
    case 'village':
      return clean(geo.village) || clean(geo.cell) || UNRECORDED;
  }
}

/** Does a row sit inside the chosen path? */
export function matchesGeoPath(row: GeoQueueRow, path: GeoPath): boolean {
  if (path.landlordId && row.landlord_id !== path.landlordId) return false;
  const pairs: [Level, string | undefined][] = [
    ['country', path.country],
    ['region', path.region],
    ['district', path.district],
    ['county', path.county],
    ['subcounty', path.subcounty],
    ['village', path.village],
  ];
  return pairs.every(([lvl, want]) => !want || geoValueAt(row.geo, lvl) === want);
}

function nextLevel(path: GeoPath): Level | 'landlord' {
  for (const lvl of LEVELS) {
    if (!path[lvl as keyof GeoPath]) return lvl;
  }
  return 'landlord';
}

interface Props {
  rows: GeoQueueRow[];
  path: GeoPath;
  onChange: (path: GeoPath) => void;
}

export function LandlordVerificationGeoBrowser({ rows, path, onChange }: Props) {
  const scoped = useMemo(
    () => rows.filter((r) => matchesGeoPath(r, { ...path, landlordId: undefined })),
    [rows, path],
  );

  const level = nextLevel(path);

  const groups = useMemo(() => {
    if (level === 'landlord') return [];
    const map = new Map<string, { label: string; count: number; landlords: Set<string> }>();
    for (const r of scoped) {
      const label = geoValueAt(r.geo, level);
      const g = map.get(label) || { label, count: 0, landlords: new Set<string>() };
      g.count += 1;
      g.landlords.add(r.landlord_id);
      map.set(label, g);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [scoped, level]);

  const crumbs = useMemo(() => {
    const out: { label: string; value: string; path: GeoPath }[] = [];
    const acc: GeoPath = {};
    for (const lvl of LEVELS) {
      const v = path[lvl as keyof GeoPath] as string | undefined;
      if (!v) break;
      (acc as Record<string, string>)[lvl] = v;
      out.push({ label: LEVEL_LABEL[lvl], value: v, path: { ...acc } });
    }
    return out;
  }, [path]);

  const selectAt = (lvl: Level, value: string) => {
    const next: GeoPath = {};
    for (const l of LEVELS) {
      if (l === lvl) break;
      const v = path[l as keyof GeoPath] as string | undefined;
      if (v) (next as Record<string, string>)[l] = v;
    }
    (next as Record<string, string>)[lvl] = value;
    onChange(next);
  };

  return (
    <div className="rounded-xl border border-amber-500/25 bg-background/70 p-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Browse by location
        </span>
        <button
          type="button"
          onClick={() => onChange({})}
          className="text-[11px] font-medium text-foreground hover:underline"
        >
          All locations
        </button>
        {crumbs.map((c) => (
          <span key={c.label} className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              onClick={() => onChange(c.path)}
              className="text-[11px] font-medium text-foreground hover:underline"
              title={c.label}
            >
              {c.value}
            </button>
          </span>
        ))}
        {path.landlordId && (
          <span className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              onClick={() => onChange({ ...path, landlordId: undefined })}
              className="text-[11px] font-medium text-foreground hover:underline"
            >
              Selected landlord
            </button>
          </span>
        )}
        <Badge variant="secondary" className="ml-auto h-5 text-[10px]">
          {scoped.length} request{scoped.length === 1 ? '' : 's'}
        </Badge>
      </div>

      {level !== 'landlord' ? (
        groups.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">
            No requests recorded in this area.
          </p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((g) => (
              <button
                key={g.label}
                type="button"
                onClick={() => selectAt(level, g.label)}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left transition-colors hover:border-amber-500/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold text-foreground">{g.label}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {LEVEL_LABEL[level]} · {g.landlords.size} landlord{g.landlords.size === 1 ? '' : 's'}
                  </span>
                </span>
                <Badge variant="outline" className="shrink-0 h-5 text-[10px]">{g.count}</Badge>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="space-y-1.5">
          {scoped.length === 0 ? (
            <p className="py-3 text-center text-[11px] text-muted-foreground">No landlords here.</p>
          ) : (
            scoped.map((r) => {
              const hasGps = r.geo?.latitude != null && r.geo?.longitude != null;
              const active = path.landlordId === r.landlord_id;
              return (
                <div
                  key={`${r.landlord_id}-${r.status}`}
                  className={`rounded-lg border px-2.5 py-2 ${active ? 'border-amber-500/70 bg-amber-500/5' : 'border-border bg-background'}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold text-foreground">
                      {r.landlord_name || 'Unnamed landlord'}
                    </span>
                    <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">{r.status}</Badge>
                    {r.landlord_phone && (
                      <a href={`tel:${r.landlord_phone}`} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                        <Phone className="h-3 w-3" /> {r.landlord_phone}
                      </a>
                    )}
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <UserCircle className="h-3 w-3" />
                    Agent {r.agent_name || '—'}{r.agent_phone ? ` · ${r.agent_phone}` : ''}
                    <MapPin className="ml-1.5 h-3 w-3" />
                    {[geoValueAt(r.geo, 'village'), geoValueAt(r.geo, 'subcounty'), geoValueAt(r.geo, 'district')]
                      .filter((v) => v !== UNRECORDED)
                      .join(', ') || UNRECORDED}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant={active ? 'secondary' : 'outline'}
                      className="h-6 px-2 text-[10px]"
                      onClick={() => onChange({ ...path, landlordId: active ? undefined : r.landlord_id })}
                    >
                      {active ? 'Showing this landlord' : 'Show in queue below'}
                    </Button>
                    {hasGps && (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${r.geo!.latitude},${r.geo!.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-foreground hover:border-amber-500/60"
                      >
                        <Navigation className="h-3 w-3" />
                        GPS {r.geo!.latitude!.toFixed(5)}, {r.geo!.longitude!.toFixed(5)}
                      </a>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
