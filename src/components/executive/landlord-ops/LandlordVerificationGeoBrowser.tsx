/**
 * Geographic navigator for the landlord verification queue.
 *
 * Read-only presentation over the rows the panel already loaded: it groups the
 * queue by the location recorded on each landlord
 * (Country -> Region -> District -> County -> Sub-county -> Village/Cell -> landlord)
 * and reports the chosen path back so the queue below filters to it. Recorded
 * location text is never rewritten; blanks are grouped as "Not recorded".
 */
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowLeft, ChevronRight, MapPin, Navigation, UserCircle, Globe, Search, X, Copy, Check } from 'lucide-react';
import { CallButton } from './CallButton';

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
  /** landlord_id -> tenants with a recorded phone, for tap-to-call buttons. */
  tenantsByLandlord?: Record<string, { name: string; phone: string }[]>;
}

export function LandlordVerificationGeoBrowser({ rows, path, onChange, tenantsByLandlord }: Props) {
  const [query, setQuery] = useState('');
  // Per-row "copied" feedback for the Copy location link action.
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const mapsUrlFor = (geo: LandlordGeo) =>
    `https://www.google.com/maps/search/?api=1&query=${geo.latitude},${geo.longitude}`;

  const copyLocationLink = async (row: GeoQueueRow) => {
    if (!row.geo || row.geo.latitude == null || row.geo.longitude == null) return;
    const url = mapsUrlFor(row.geo);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API can be unavailable (older browsers / non-secure context) —
      // fall back to a temporary textarea copy.
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopiedId(row.landlord_id);
    window.setTimeout(() => setCopiedId((c) => (c === row.landlord_id ? null : c)), 2000);
  };

  const scoped = useMemo(
    () => rows.filter((r) => matchesGeoPath(r, { ...path, landlordId: undefined })),
    [rows, path],
  );

  const level = nextLevel(path);

  useEffect(() => setQuery(''), [level, path.landlordId]);

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

  const goBack = () => {
    if (path.landlordId) {
      onChange({ ...path, landlordId: undefined });
      return;
    }
    const selected = LEVELS.filter((lvl) => path[lvl as keyof GeoPath]);
    const previous = selected[selected.length - 1];
    if (!previous) return;
    const next = { ...path };
    delete next[previous];
    onChange(next);
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = normalizedQuery
    ? groups.filter((group) => group.label.toLowerCase().includes(normalizedQuery))
    : groups;
  const visibleLandlords = normalizedQuery
    ? scoped.filter((row) =>
        [row.landlord_name, row.landlord_phone, row.agent_name, row.agent_phone]
          .some((value) => clean(value).toLowerCase().includes(normalizedQuery)))
    : scoped;
  const hasPath = crumbs.length > 0 || !!path.landlordId;

  const currentStepIndex = level === 'landlord' ? LEVELS.length : LEVELS.indexOf(level);

  return (
    <div className="rounded-lg border border-amber-500/25 bg-background/70 p-3 space-y-3 sm:rounded-xl">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-12 shrink-0 gap-1.5 px-3 sm:h-10"
          onClick={goBack}
          disabled={!hasPath}
          aria-label="Back to previous level"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {level === 'landlord'
              ? `Step ${LEVELS.length + 1} of ${LEVELS.length + 1} · Choose a landlord`
              : `Step ${currentStepIndex + 1} of ${LEVELS.length + 1} · Choose ${LEVEL_LABEL[level].toLowerCase()}`}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {crumbs.length ? crumbs.map((crumb) => crumb.value).join(' › ') : 'All locations'}
          </p>
        </div>
        <Badge variant="secondary" className="h-7 shrink-0 text-[11px]">
          {scoped.length}
        </Badge>
      </div>

      {/* Stepper: every level, tappable once reached */}
      <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1">
        <Button
          type="button"
          variant={hasPath ? 'ghost' : 'secondary'}
          size="sm"
          onClick={() => onChange({})}
          className="h-11 shrink-0 gap-1.5 px-3 text-xs"
        >
          <Globe className="h-4 w-4" /> All
        </Button>
        {LEVELS.map((lvl, i) => {
          const value = path[lvl as keyof GeoPath] as string | undefined;
          const reached = i <= currentStepIndex;
          const isCurrent = level === lvl;
          return (
            <span key={lvl} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <Button
                type="button"
                variant={isCurrent ? 'secondary' : 'ghost'}
                size="sm"
                disabled={!reached}
                onClick={() => {
                  const next: GeoPath = {};
                  for (const l of LEVELS) {
                    if (l === lvl) break;
                    const v = path[l as keyof GeoPath] as string | undefined;
                    if (v) (next as Record<string, string>)[l] = v;
                  }
                  onChange(next);
                }}
                className="h-11 max-w-[10rem] shrink-0 flex-col items-start gap-0 px-3 py-1 text-left"
                title={LEVEL_LABEL[lvl]}
              >
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{LEVEL_LABEL[lvl]}</span>
                <span className="max-w-[9rem] truncate text-xs font-semibold">{value || (isCurrent ? 'Choose…' : '—')}</span>
              </Button>
            </span>
          );
        })}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={level === 'landlord' ? 'Search landlord, agent or phone' : `Search ${LEVEL_LABEL[level].toLowerCase()}`}
          aria-label="Search the current location level"
          className="h-12 bg-background pl-9 pr-12 text-sm"
        />
        {query && (
          <Button type="button" variant="ghost" size="icon" aria-label="Clear location search" className="absolute right-0 top-0 h-12 w-12" onClick={() => setQuery('')}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>


      {level !== 'landlord' ? (
        visibleGroups.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">
            {query ? 'No locations match your search.' : 'No requests recorded in this area.'}
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleGroups.map((g) => (
              <button
                key={g.label}
                type="button"
                onClick={() => selectAt(level, g.label)}
                className="flex min-h-16 w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:border-amber-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-foreground">{g.label}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {LEVEL_LABEL[level]} · {g.landlords.size} landlord{g.landlords.size === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Badge variant="outline" className="h-6 text-[11px]">{g.count}</Badge>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </span>

              </button>
            ))}
          </div>
        )
      ) : (
        <div className="space-y-1.5">
          {visibleLandlords.length === 0 ? (
            <p className="py-3 text-center text-[11px] text-muted-foreground">{query ? 'No landlords match your search.' : 'No landlords here.'}</p>
          ) : (
            visibleLandlords.map((r) => {
              const hasGps = r.geo?.latitude != null && r.geo?.longitude != null;
              const active = path.landlordId === r.landlord_id;
              return (
                <div
                  key={`${r.landlord_id}-${r.status}`}
                  className={`rounded-lg border px-3 py-3 ${active ? 'border-amber-500/70 bg-amber-500/5' : 'border-border bg-background'}`}
                >
                   <div className="flex flex-wrap items-center gap-2">
                     <span className="text-[12px] font-semibold text-foreground">
                       {r.landlord_name || 'Unnamed landlord'}
                     </span>
                     <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">{r.status}</Badge>
                   </div>
                   <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                     <UserCircle className="h-3 w-3" />
                     Agent {r.agent_name || '—'}{r.agent_phone ? ` · ${r.agent_phone}` : ''}
                     <MapPin className="ml-1.5 h-3 w-3" />
                     {[geoValueAt(r.geo, 'village'), geoValueAt(r.geo, 'subcounty'), geoValueAt(r.geo, 'district')]
                       .filter((v) => v !== UNRECORDED)
                       .join(', ') || UNRECORDED}
                   </p>
                    <div className="mt-2 flex flex-col gap-2 min-[420px]:flex-row min-[420px]:flex-wrap">
                      <CallButton phone={r.landlord_phone} who="landlord" className="w-full min-[420px]:w-auto" />
                      <CallButton phone={r.agent_phone} who="agent" className="w-full min-[420px]:w-auto" />
                      {(tenantsByLandlord?.[r.landlord_id] ?? []).map((t) => (
                        <CallButton
                          key={t.phone}
                          phone={t.phone}
                          who={`tenant ${t.name}`}
                          className="w-full min-[420px]:w-auto"
                        />
                      ))}
                    </div>
                   <div className="mt-2.5 flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-center">
                     <Button
                       size="sm"
                       variant={active ? 'secondary' : 'outline'}
                        className="h-11 w-full px-3 text-xs min-[420px]:w-auto"
                       onClick={() => onChange({ ...path, landlordId: active ? undefined : r.landlord_id })}
                     >
                       {active ? 'Showing this landlord' : 'Show in queue below'}
                     </Button>
                     {hasGps && (
                       <div className="flex w-full flex-col gap-2 min-[420px]:w-auto min-[420px]:flex-row">
                         <Button
                           asChild
                           size="sm"
                           className="h-12 w-full gap-2 bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 min-[420px]:w-auto"
                         >
                           <a
                             href={mapsUrlFor(r.geo!)}
                             target="_blank"
                             rel="noreferrer"
                             aria-label={`Open GPS for ${r.landlord_name || 'landlord'} in Google Maps`}
                           >
                             <Navigation className="h-4 w-4" />
                             Open GPS
                           </a>
                         </Button>
                         <Button
                           type="button"
                           size="sm"
                           variant="outline"
                           className="h-12 w-full gap-2 px-4 text-sm min-[420px]:w-auto"
                           onClick={() => copyLocationLink(r)}
                           aria-label={`Copy location link for ${r.landlord_name || 'landlord'}`}
                         >
                           {copiedId === r.landlord_id ? (
                             <>
                               <Check className="h-4 w-4 text-emerald-600" />
                               Copied
                             </>
                           ) : (
                             <>
                               <Copy className="h-4 w-4" />
                               Copy location link
                             </>
                           )}
                         </Button>
                       </div>
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
