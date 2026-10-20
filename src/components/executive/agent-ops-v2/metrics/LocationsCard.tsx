/// <reference types="google.maps" />
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useGoogleMapsLoader } from '@/hooks/useGoogleMapsLoader';
import { useMetricsLocations, useMetricsPins, type LocationLevel, type MapBox } from '@/hooks/useAgentOpsMetrics';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import { LOCATION_CSV_HEADERS, MAP_PIN_LIMIT, UGANDA_BOX, locationCsvRow, locationLabel, metricsCsvName, metricsPreamble, type MetricsPin } from '@/lib/agentMetrics';
import { cn } from '@/lib/utils';
import { CardShell, ListSkeleton, type CardControls } from './MetricsShared';
import { num } from './metricsFormat';

const BASIS = 'Houses listed in the dates, grouped by where the listing was recorded. Verified, pending and GPS counts are the same houses as the Listings card. As the server returns them.';
const LEVELS: { id: LocationLevel; label: string }[] = [
  { id: 'region', label: 'Regions' },
  { id: 'district', label: 'Districts' },
  { id: 'sub_county', label: 'Sub-counties' },
];

/** true from the md breakpoint (768px) up; the map is not even created below it. */
function useFromMd(): boolean {
  const query = '(min-width: 768px)';
  const [on, setOn] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const h = () => setOn(m.matches);
    h();
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return on;
}

export function LocationsCard({ controls, from, to }: { controls: CardControls; from: string; to: string }) {
  const [level, setLevel] = useState<LocationLevel>('district');
  const q = useMetricsLocations(from, to, level);
  const wide = useFromMd();
  const csv = q.rows.length
    ? () => downloadCsvWithPreamble(metricsCsvName(`locations-${level}`, from, to), metricsPreamble(`Locations by ${level.replace('_', '-')}`, from, to, BASIS), LOCATION_CSV_HEADERS, q.rows.map(locationCsvRow))
    : undefined;
  return (
    <CardShell id="locations" controls={controls} state={q} basis={BASIS} onCsv={csv} skeleton={<ListSkeleton />} empty={q.rows.length === 0 && !q.isFetching} emptyText="No houses were listed in these dates.">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Group by">
        {LEVELS.map((l) => (
          <Button key={l.id} type="button" size="sm" variant={level === l.id ? 'default' : 'outline'} className="min-h-11" aria-pressed={level === l.id} onClick={() => setLevel(l.id)}>{l.label}</Button>
        ))}
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border" data-testid="metrics-location-list">
        {q.rows.map((l, i) => (
          <li key={`${l.region}|${l.district}|${l.sub_county}|${i}`} className="flex items-start justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{locationLabel(l, level)}</p>
              <p className="text-xs text-muted-foreground">{num(l.agents)} agents, {num(l.houses_verified)} verified, {num(l.houses_pending)} pending, {num(l.houses_with_gps)} with GPS</p>
            </div>
            <p className="shrink-0 text-sm font-bold tabular-nums text-foreground">{num(l.houses_listed)}<span className="ml-1 text-xs font-normal text-muted-foreground">houses</span></p>
          </li>
        ))}
      </ul>
      {wide && <PinsMap />}
    </CardShell>
  );
}

function cssColor(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v ? `hsl(${v})` : fallback;
  } catch { return fallback; }
}

/** Every house pin inside the part of the map you can see (up to the server ceiling of 2,000). Browser JavaScript API only; the pins come from the server. */
function PinsMap() {
  const maps = useGoogleMapsLoader(true);
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markers = useRef<google.maps.Marker[]>([]);
  const [box, setBox] = useState<MapBox>({ ...UGANDA_BOX });
  const pins = useMetricsPins(box, maps.isReady);

  useEffect(() => {
    if (!maps.isReady || !holder.current || mapRef.current) return;
    const map = new google.maps.Map(holder.current, {
      center: { lat: 1.37, lng: 32.3 }, zoom: 7, mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
    });
    mapRef.current = map;
    map.addListener('idle', () => {
      const b = map.getBounds();
      if (!b) return;
      const ne = b.getNorthEast();
      const sw = b.getSouthWest();
      setBox({ minLat: sw.lat(), minLng: sw.lng(), maxLat: ne.lat(), maxLng: ne.lng() });
    });
  }, [maps.isReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.forEach((m) => m.setMap(null));
    const ok = cssColor('--primary', '#6d28d9');
    const wait = cssColor('--muted-foreground', '#6b7280');
    markers.current = pins.rows.map((p: MetricsPin) => new google.maps.Marker({
      map, position: { lat: p.latitude, lng: p.longitude },
      title: `${p.district ?? 'No district'}: ${p.verified ? 'verified' : 'not verified'}`,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: p.verified ? ok : wait, fillOpacity: 0.85, strokeColor: '#ffffff', strokeWeight: 1 },
    }));
    return () => { markers.current.forEach((m) => m.setMap(null)); markers.current = []; };
  }, [pins.rows, maps.isReady]);

  return (
    <div className="space-y-1" data-testid="metrics-map">
      <div className={cn('relative h-80 overflow-hidden rounded-xl border border-border bg-muted', !maps.isReady && 'flex items-center justify-center')}>
        {maps.isError ? (
          <p className="p-4 text-center text-sm text-muted-foreground" role="status">
            {maps.errorReason === 'referrer' ? 'The map key is not allowed for this address, so the map cannot load. The district list above still has every count.' : 'The map could not load. The district list above still has every count.'}
          </p>
        ) : !maps.isReady ? (
          <p className="text-sm text-muted-foreground" role="status">Loading the map</p>
        ) : (
          <div ref={holder} className="absolute inset-0" aria-label="Map of listed houses" />
        )}
      </div>
      {maps.isReady && (
        <p className="text-xs text-muted-foreground">
          {num(pins.rows.length)} houses in view{pins.rows.length >= MAP_PIN_LIMIT ? ` (the first ${num(MAP_PIN_LIMIT)}; zoom in to see the rest)` : ''}. Filled pins are verified houses, grey pins are not yet verified. Pins show every house ever listed, not only the chosen dates.
        </p>
      )}
      {pins.error != null && !pins.isFetching && <p role="alert" className="text-xs text-destructive">Could not load the pins. <button type="button" className="min-h-11 underline" onClick={pins.refetch}>Retry</button></p>}
    </div>
  );
}
