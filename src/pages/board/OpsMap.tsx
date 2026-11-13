/// <reference types="google.maps" />
import { useEffect, useRef, useState } from 'react';
import { loadGoogleMapsWith } from '@/lib/googleMapsScript';
import { boardMapsKey } from '@/lib/boardDisplayClient';
import { LAYER_ORDER, cellScale, type BoardMap, type Cell, type LayerKey, type MoneyPoint } from '@/lib/boardMap';

/**
 * The ops map (screen 3, E96): Google Maps through the app's shared loader,
 * dark night style without POI labels, centred on Uganda. The map is made once
 * and kept, so the room's pan and zoom survive the 30-second refresh; only the
 * markers are redrawn. Markers keep their pixel size at every zoom (readable on
 * a TV):
 *   sold          green dots
 *   selected      pulsing amber rings, a dashed amber line to the agent's base when known
 *   on board      cyan squares
 *   desks / repaying / arrears   circles sized by n
 *   agents        white diamonds (frozen: amber outline)
 *   empty houses  faint heat
 * A tap on a sold or selected marker opens its card (onPick).
 */

export type Picked = { kind: 'sold' | 'selected'; point: MoneyPoint };

const UGANDA = { lat: 1.37, lng: 32.29 };
const UGANDA_ZOOM = 7;
/** The first view fills the box with Uganda; after that the room's pan and zoom are kept. */
export const UGANDA_BOUNDS = { south: -1.5, west: 29.5, north: 4.25, east: 35.05 };

const C = { green: '#3DD68C', amber: '#F5A524', cyan: '#38D0E8', blue: '#3D5A86', blueLine: '#5B7DB0', red: '#F0524F', white: '#D7E3EC', ground: '#05080C' };

export const NIGHT_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#0B131B' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5E7384' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#05080C' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#2C4152' }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#3A5468' }, { weight: 1.5 }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#8FA3B3' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#16222E' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#1F2F3D' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0B131B' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#071722' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#2E6178' }] },
];

type Overlay = google.maps.Marker | google.maps.Polyline;

/** Google wants a bare {lat, lng}: a point's other fields (names, amounts) never go to the map API. */
const at = (p: { lat: number; lng: number }): google.maps.LatLngLiteral => ({ lat: p.lat, lng: p.lng });

const reducedMotion = () => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
};

/** The selected ring: a steady ring and, unless motion is reduced, one that grows and fades. */
export function selectedRingSvg(animate: boolean): string {
  const pulse = animate
    ? "<circle cx='32' cy='32' r='9' fill='none' stroke='#F5A524' stroke-width='2'><animate attributeName='r' from='9' to='28' dur='2.4s' repeatCount='indefinite'/><animate attributeName='opacity' from='0.9' to='0' dur='2.4s' repeatCount='indefinite'/></circle>"
    : '';
  return `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><circle cx='32' cy='32' r='9' fill='#140E04' fill-opacity='0.6' stroke='#F5A524' stroke-width='3'/>${pulse}</svg>`;
}

function build(maps: typeof google.maps, data: BoardMap, onPick: (p: Picked) => void): Record<LayerKey, Overlay[]> {
  const out = Object.fromEntries(LAYER_ORDER.map((k) => [k, [] as Overlay[]])) as Record<LayerKey, Overlay[]>;
  const circle = (fill: string, opacity: number, scale: number, stroke?: string): google.maps.Symbol => ({
    path: maps.SymbolPath.CIRCLE, fillColor: fill, fillOpacity: opacity, scale,
    strokeColor: stroke ?? fill, strokeOpacity: stroke ? 0.9 : 0, strokeWeight: stroke ? 1 : 0,
  });
  const cellsTo = (key: LayerKey, cells: Cell[], icon: (n: number) => google.maps.Symbol, z: number) => {
    for (const c of cells) out[key].push(new maps.Marker({ position: at(c), icon: icon(c.n), zIndex: z, clickable: false }));
  };

  // Back to front.
  cellsTo('emptyHouses', data.layers.emptyHouses, (n) => circle('#8FA3B3', 0.08, cellScale(n, 8, 2.2, 40)), 1);
  cellsTo('repaying', data.layers.repaying, (n) => circle('#7F96AA', 0.28, cellScale(n), '#7F96AA'), 2);
  cellsTo('desks', data.layers.desks, (n) => circle(C.blue, 0.55, cellScale(n), C.blueLine), 3);
  cellsTo('arrearsToday', data.layers.arrearsToday, (n) => circle(C.red, 0.65, cellScale(n, 4, 2, 20), C.red), 4);

  for (const p of data.layers.onBoard) {
    out.onBoard.push(new maps.Marker({
      position: at(p), zIndex: 5, clickable: false,
      icon: { path: 'M -1 -1 L 1 -1 L 1 1 L -1 1 Z', fillColor: C.cyan, fillOpacity: 0.95, strokeWeight: 0, scale: 4 },
    }));
  }
  for (const a of data.layers.agents) {
    out.agents.push(new maps.Marker({
      position: at(a), zIndex: 6, clickable: false, title: a.name ?? undefined,
      icon: { path: 'M 0 -1 L 1 0 L 0 1 L -1 0 Z', fillColor: C.ground, fillOpacity: 0.9, strokeColor: a.frozen ? C.amber : C.white, strokeWeight: 2, scale: 7 },
    }));
  }
  for (const p of data.layers.sold) {
    const m = new maps.Marker({ position: at(p), zIndex: 7, icon: circle(C.green, 0.95, 7, C.ground) });
    m.addListener('click', () => onPick({ kind: 'sold', point: p }));
    out.sold.push(m);
  }
  const ring = {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(selectedRingSvg(!reducedMotion()))}`,
    scaledSize: new maps.Size(64, 64),
    anchor: new maps.Point(32, 32),
  };
  for (const p of data.layers.selected) {
    if (p.agentLat !== null && p.agentLng !== null) {
      out.selected.push(new maps.Polyline({
        path: [at(p), { lat: p.agentLat, lng: p.agentLng }], strokeOpacity: 0, zIndex: 7, clickable: false,
        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: C.amber, strokeWeight: 2, scale: 3 }, offset: '0', repeat: '12px' }],
      }));
    }
    // Animated SVG needs an unoptimised marker to keep moving.
    const m = new maps.Marker({ position: at(p), zIndex: 8, icon: ring, optimized: false });
    m.addListener('click', () => onPick({ kind: 'selected', point: p }));
    out.selected.push(m);
  }
  return out;
}

export function OpsMap({ data, visible, onPick }: { data: BoardMap; visible: Record<LayerKey, boolean>; onPick: (p: Picked) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const mapsRef = useRef<typeof google.maps | null>(null);
  const layers = useRef<Record<LayerKey, Overlay[]> | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [why, setWhy] = useState('');

  // The map: once.
  useEffect(() => {
    let live = true;
    loadGoogleMapsWith(boardMapsKey)
      .then((maps) => {
        if (!live || !box.current) return;
        mapsRef.current = maps;
        mapRef.current = new maps.Map(box.current, {
          center: UGANDA, zoom: UGANDA_ZOOM, styles: NIGHT_STYLE, backgroundColor: '#05080C',
          disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false, keyboardShortcuts: false,
        });
        mapRef.current.fitBounds(UGANDA_BOUNDS, 0);
        setState('ready');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setWhy(e instanceof Error && e.message ? e.message : 'The map could not be loaded.');
        setState('error');
      });
    return () => {
      live = false;
    };
  }, []);

  // The markers: on every refresh. The view (centre, zoom) is never touched.
  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (state !== 'ready' || !maps || !map) return;
    const next = build(maps, data, (p) => pick.current(p));
    for (const k of LAYER_ORDER) for (const o of next[k]) o.setMap(visible[k] ? map : null);
    const old = layers.current;
    layers.current = next;
    if (old) for (const k of LAYER_ORDER) for (const o of old[k]) o.setMap(null);
    // visible is applied by the next effect; it is read here only for the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, state]);

  // The layer switches.
  useEffect(() => {
    const map = mapRef.current;
    const l = layers.current;
    if (!map || !l) return;
    for (const k of LAYER_ORDER) for (const o of l[k]) o.setMap(visible[k] ? map : null);
  }, [visible]);

  // Gone with the screen.
  useEffect(
    () => () => {
      const l = layers.current;
      if (l) for (const k of LAYER_ORDER) for (const o of l[k]) o.setMap(null);
    },
    [],
  );

  return (
    <>
      <div ref={box} className="ops-map-canvas" data-ops-map={state} role="img" aria-label="Map of Uganda: requests, selections, sales, agents and arrears" />
      {state === 'loading' && <div className="ops-map-message">Loading the map…</div>}
      {state === 'error' && <div className="ops-map-message" role="alert">Map unavailable: {why}</div>}
    </>
  );
}
