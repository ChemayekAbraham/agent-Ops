import { useMemo } from 'react';

/**
 * The boardroom's PIPELINE and OPS MAP screens are LIGHT by default, read
 * from across a room; `?theme=dark` on the page's URL brings back the old
 * dark look. The FUNDERS screen keeps its own look. The light colours live
 * here (and, as CSS variables, under `.ops-board.ops-light` in opsBoard.css);
 * every text colour on its background is at least 4.5:1, the big numbers
 * (ink) at least 7:1.
 */

export type OpsTheme = 'light' | 'dark';

export const LIGHT = {
  ground: '#F6F5FB',
  panel: '#FFFFFF',
  line: '#E4E2EE',
  ink: '#1B1A2E',
  muted: '#55546A',
  accent: '#6D28D9',
  green: '#15803D',
  amber: '#B45309',
  red: '#B91C1C',
  blue: '#1D4ED8',
} as const;

export function readOpsTheme(search: string): OpsTheme {
  return new URLSearchParams(search || '').get('theme') === 'dark' ? 'dark' : 'light';
}

/** The page's theme, from its URL, once. */
export function useOpsTheme(): OpsTheme {
  return useMemo(() => readOpsTheme(typeof window === 'undefined' ? '' : window.location.search), []);
}

/** WCAG 2 relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two #RRGGBB colours. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The map's colours per theme: markers in the status colours; in light, each with a white outline. */
export const MAP_COLORS: Record<OpsTheme, {
  sold: string; selected: string; onBoard: string; desks: string; desksLine: string; arrears: string;
  repaying: string; empty: string; agentFill: string; agentLine: string; outline: string; ground: string;
}> = {
  dark: {
    sold: '#3DD68C', selected: '#F5A524', onBoard: '#38D0E8', desks: '#3D5A86', desksLine: '#5B7DB0', arrears: '#F0524F',
    repaying: '#7F96AA', empty: '#8FA3B3', agentFill: '#05080C', agentLine: '#D7E3EC', outline: '#05080C', ground: '#05080C',
  },
  light: {
    sold: LIGHT.green, selected: LIGHT.amber, onBoard: LIGHT.accent, desks: LIGHT.blue, desksLine: '#FFFFFF', arrears: LIGHT.red,
    repaying: LIGHT.muted, empty: LIGHT.muted, agentFill: '#FFFFFF', agentLine: LIGHT.ink, outline: '#FFFFFF', ground: LIGHT.ground,
  },
};

/** The light basemap: white land, light grey roads, pale blue water, no points of interest. */
export const LIGHT_MAP_STYLE: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#FFFFFF' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: LIGHT.muted }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#C9C6D9' }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#9A97B0' }, { weight: 1.5 }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: LIGHT.ink }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#E6E5EE' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#D6D4E2' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#CFE3F5' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#3A6A92' }] },
];
