/**
 * WCAG contrast utilities.
 *
 * These let promo banners / card panels pick a guaranteed-readable text
 * colour for any solid background, instead of hand-picking translucent
 * whites that can collapse to near-solid white on some devices (which is
 * how buttons/labels became "lost in the whitish color").
 */

export type RGB = { r: number; g: number; b: number };

const clamp255 = (n: number) => Math.max(0, Math.min(255, n));

/** Parse a hex colour (#rgb / #rrggbb) into RGB. */
function parseHex(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Parse an `hsl(H S% L%)` or `hsl(H, S%, L%)` string into RGB. */
function parseHsl(input: string): RGB | null {
  const m = input
    .trim()
    .match(/^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/i);
  if (!m) return null;
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: clamp255(r * 255), g: clamp255(g * 255), b: clamp255(b * 255) };
}

/** Best-effort parse of hex or hsl colour strings. */
export function parseColor(color: string): RGB | null {
  if (!color) return null;
  if (color.startsWith('#')) return parseHex(color);
  if (color.toLowerCase().startsWith('hsl')) return parseHsl(color);
  return null;
}

/** Relative luminance per WCAG 2.x. */
export function relativeLuminance({ r, g, b }: RGB): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1–21) between two colours. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const LIGHT_FG: RGB = { r: 255, g: 255, b: 255 }; // #ffffff
const DARK_FG: RGB = { r: 15, g: 23, b: 42 }; // slate-900 #0f172a

export const READABLE_LIGHT = '#ffffff';
export const READABLE_DARK = '#0f172a';

/**
 * Pick the foreground colour (light or dark) with the highest contrast
 * against the given solid background. Falls back to white if the colour
 * can't be parsed.
 */
export function getReadableTextColor(background: string): string {
  const bg = parseColor(background);
  if (!bg) return READABLE_LIGHT;
  const withLight = contrastRatio(bg, LIGHT_FG);
  const withDark = contrastRatio(bg, DARK_FG);
  return withLight >= withDark ? READABLE_LIGHT : READABLE_DARK;
}

/** WCAG AA threshold for normal-size text. */
export const AA_NORMAL = 4.5;
/** WCAG AA threshold for large/bold text. */
export const AA_LARGE = 3;

/**
 * Returns true when foreground/background meet the requested WCAG ratio.
 */
export function meetsContrast(
  foreground: string,
  background: string,
  threshold: number = AA_NORMAL,
): boolean {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return true; // can't verify → don't block render
  return contrastRatio(fg, bg) >= threshold;
}

/**
 * Dev-only guard: warns in the console when a foreground/background pair
 * fails WCAG AA so low-contrast regressions surface during development.
 * No-ops in production.
 */
export function assertReadableContrast(
  foreground: string,
  background: string,
  label = 'panel',
  threshold: number = AA_NORMAL,
  /** Override for testing the production short-circuit. */
  _isProd?: boolean,
): void {
  const isProd = _isProd ?? import.meta.env?.PROD;
  if (isProd) return;
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return;
  const ratio = contrastRatio(fg, bg);
  if (ratio < threshold) {
    // eslint-disable-next-line no-console
    console.warn(
      `[contrast] Low contrast on "${label}": ${ratio.toFixed(2)}:1 ` +
        `(needs ${threshold}:1) for ${foreground} on ${background}. ` +
        `Consider getReadableTextColor() or a darker/lighter panel.`,
    );
  }
}