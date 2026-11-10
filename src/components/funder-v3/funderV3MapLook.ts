/**
 * Funder V3 map look: the light base style, price pills, area/cluster bubbles.
 * Presentation only — every label comes from the live helpers (the pill text
 * is the live pin's `formatDynamicCompact` amount, unchanged).
 */
import { formatDynamicCompact } from '@/lib/currencyFormat';

/** Welile purple (`--primary: 271 100% 40%`), as a literal for SVG data URIs. */
export const WELILE_PURPLE = '#6900cc';

/** Optional Google Cloud map id: when set, the map is vector and pins are HTML (AdvancedMarkerElement). */
export function funderV3MapId(): string | undefined {
  const id = import.meta.env['VITE_GOOGLE_MAP_ID'] as string | undefined;
  return id && id.trim() ? id.trim() : undefined;
}

/**
 * Clean light base style for raster maps (ignored by Google when a map id is set;
 * the cloud style should mirror it). Soft grey land, light blue water, white
 * roads, quiet labels; POIs, transit and business icons hidden; area and road
 * names kept.
 */
export const FUNDER_V3_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#f2f3f5' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#7b8088' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f7f8fa' }, { weight: 3 }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#5d626b' }] },
  { featureType: 'administrative.neighborhood', elementType: 'labels.text.fill', stylers: [{ color: '#8a8f97' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#eceef1' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#eef0ee' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#e4ece3' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#e3e5e9' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8d929a' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#d9dce1' }] },
  { featureType: 'road.local', elementType: 'labels', stylers: [{ visibility: 'simplified' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#cfe3f3' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#7f9db5' }] },
];

/**
 * Pin tone. `plain` = white pill (tags off). With E59 board tags on, pins take
 * their tag colour: `empty` (Empty house) grey, `verified` (Verified) purple.
 */
export type PinTone = 'plain' | 'empty' | 'verified';

/** Map pins are cells of house_listings (empty houses); a cell that carries a verified tenant would be purple. */
export function pinToneFor(tagsOn: boolean, kind: 'empty' | 'verified'): PinTone {
  return tagsOn ? kind : 'plain';
}

const SLATE = '#4b5563';
const TONES: Record<PinTone, { fill: string; ink: string; stroke: string; selFill: string }> = {
  plain: { fill: '#ffffff', ink: '#1f2328', stroke: 'rgba(17,24,39,0.10)', selFill: WELILE_PURPLE },
  empty: { fill: '#e5e7eb', ink: '#374151', stroke: 'rgba(17,24,39,0.14)', selFill: SLATE },
  verified: { fill: WELILE_PURPLE, ink: '#ffffff', stroke: 'rgba(255,255,255,0.9)', selFill: '#4c0099' },
};

/** Pill label: the live pin's own text (unknown amounts fall back as live does). */
export function pinLabel(amount: number): string {
  return formatDynamicCompact(amount > 0 ? amount : 100000);
}

/** Text width estimate for the SVG pill (11.5px system font, tabular digits). */
function textWidth(text: string): number {
  return Math.round(text.length * 7.1);
}

const pillCache = new Map<string, google.maps.Icon>();

/** Raster maps: a crisp white price pill with a soft shadow; selected = purple and slightly larger. */
export function pricePillIcon(amount: number, selected: boolean, tone: PinTone = 'plain'): google.maps.Icon {
  const text = pinLabel(amount);
  const key = `${text}|${selected}|${tone}`;
  const cached = pillCache.get(key);
  if (cached) return cached;
  const scale = selected ? 1.12 : 1;
  const padX = 11;
  const height = Math.round(26 * scale);
  const width = Math.round((textWidth(text) + padX * 2) * scale);
  const shadow = 6;
  const W = width + shadow * 2;
  const H = height + shadow * 2 + 2;
  const palette = TONES[tone];
  const fill = selected ? palette.selFill : palette.fill;
  const ink = selected ? '#ffffff' : palette.ink;
  const stroke = selected ? '#ffffff' : palette.stroke;
  const fontSize = (11.5 * scale).toFixed(1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><filter id="s" x="-30%" y="-40%" width="160%" height="200%"><feDropShadow dx="0" dy="1.5" stdDeviation="2.2" flood-color="#0f172a" flood-opacity="0.22"/></filter></defs>
<rect x="${shadow}" y="${shadow}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1" filter="url(#s)"/>
<text x="${W / 2}" y="${shadow + height / 2}" fill="${ink}" font-size="${fontSize}" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle" dominant-baseline="central">${text}</text>
</svg>`;
  const icon: google.maps.Icon = {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(W, H),
    anchor: new google.maps.Point(W / 2, H / 2),
  };
  pillCache.set(key, icon);
  return icon;
}

const bubbleCache = new Map<string, google.maps.Icon>();

/** Bubble size for a count: grows gently with the number of homes. */
function bubbleSize(count: number): number {
  return Math.round(Math.min(56, 30 + Math.log10(Math.max(1, count)) * 10));
}

/** Short count text: 1,234 → "1.2K". */
export function countText(count: number): string {
  if (count >= 10_000) return `${Math.round(count / 1000)}K`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(count);
}

/** Raster maps: purple circle with a count (clusters and multi-home areas). */
export function countBubbleIcon(count: number, neutral = false): google.maps.Icon {
  const text = countText(count);
  const colour = neutral ? SLATE : WELILE_PURPLE;
  const cacheKeyText = `${text}|${neutral}`;
  const cached = bubbleCache.get(cacheKeyText);
  if (cached) return cached;
  const d = bubbleSize(count);
  const ring = 4;
  const W = d + ring * 2 + 6;
  const c = W / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
<defs><filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#0f172a" flood-opacity="0.25"/></filter></defs>
<circle cx="${c}" cy="${c}" r="${d / 2 + ring}" fill="${colour}" fill-opacity="0.18"/>
<circle cx="${c}" cy="${c}" r="${d / 2}" fill="${colour}" stroke="#ffffff" stroke-width="2" filter="url(#s)"/>
<text x="${c}" y="${c}" fill="#ffffff" font-size="${d >= 44 ? 13 : 12}" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle" dominant-baseline="central">${text}</text>
</svg>`;
  const icon: google.maps.Icon = {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(W, W),
    anchor: new google.maps.Point(c, c),
  };
  bubbleCache.set(cacheKeyText, icon);
  return icon;
}

/** Vector maps (AdvancedMarkerElement): the same pill as HTML. */
export function pricePillElement(amount: number, selected: boolean, tone: PinTone = 'plain'): HTMLElement {
  const el = document.createElement('div');
  el.className = `fv3-pin fv3-pin--${tone}${selected ? ' fv3-pin--selected' : ''}`;
  el.textContent = pinLabel(amount);
  return el;
}

/** Vector maps: the purple count bubble as HTML. */
export function countBubbleElement(count: number, neutral = false): HTMLElement {
  const el = document.createElement('div');
  const d = bubbleSize(count);
  el.className = neutral ? 'fv3-bubble fv3-bubble--neutral' : 'fv3-bubble';
  el.style.width = `${d}px`;
  el.style.height = `${d}px`;
  el.textContent = countText(count);
  return el;
}
