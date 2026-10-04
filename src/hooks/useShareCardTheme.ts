import { useEffect, useState, useCallback } from 'react';

export interface ShareCardTheme {
  /** Theme preset id */
  preset: 'purple' | 'midnight' | 'emerald' | 'sunset' | 'custom';
  /** Three gradient stops (hex) — used when preset === 'custom' */
  customStops?: [string, string, string];
}

export interface ResolvedShareCardTheme {
  /** Three-stop linear gradient colors (top-left → middle → bottom-right) */
  gradient: [string, string, string];
  /** Glow orb colors (rgba) */
  orbA: string;
  orbB: string;
  /** Accent text on dark background (e.g. accent label) */
  accent: string;
}

export const SHARE_CARD_THEME_PRESETS: Record<
  Exclude<ShareCardTheme['preset'], 'custom'>,
  { label: string; description: string; resolved: ResolvedShareCardTheme }
> = {
  purple: {
    label: 'Welile Purple',
    description: 'Brand default — matches the app',
    resolved: {
      gradient: ['#3d0066', '#7A00CC', '#1a0033'],
      orbA: 'rgba(196,128,255,0.55)',
      orbB: 'rgba(122,0,204,0.45)',
      accent: '#E9D5FF',
    },
  },
  midnight: {
    label: 'Midnight Blue',
    description: 'Calm corporate look',
    resolved: {
      gradient: ['#0f172a', '#1e3a8a', '#0b1224'],
      orbA: 'rgba(96,165,250,0.55)',
      orbB: 'rgba(59,130,246,0.40)',
      accent: '#BFDBFE',
    },
  },
  emerald: {
    label: 'Emerald',
    description: 'Money-green, growth vibe',
    resolved: {
      gradient: ['#064e3b', '#059669', '#022c22'],
      orbA: 'rgba(110,231,183,0.55)',
      orbB: 'rgba(16,185,129,0.40)',
      accent: '#A7F3D0',
    },
  },
  sunset: {
    label: 'Sunset',
    description: 'Warm African sunset',
    resolved: {
      gradient: ['#7c2d12', '#ea580c', '#1c1917'],
      orbA: 'rgba(253,186,116,0.55)',
      orbB: 'rgba(234,88,12,0.40)',
      accent: '#FED7AA',
    },
  },
};

const STORAGE_KEY = 'welile.shareCardTheme.v1';
const DEFAULT: ShareCardTheme = { preset: 'purple' };

function read(): ShareCardTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.preset === 'string') return parsed as ShareCardTheme;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

function write(t: ShareCardTheme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

export function resolveShareCardTheme(t: ShareCardTheme): ResolvedShareCardTheme {
  if (t.preset !== 'custom') {
    return SHARE_CARD_THEME_PRESETS[t.preset].resolved;
  }
  const stops = t.customStops ?? SHARE_CARD_THEME_PRESETS.purple.resolved.gradient;
  return {
    gradient: stops,
    orbA: 'rgba(255,255,255,0.35)',
    orbB: 'rgba(0,0,0,0.25)',
    accent: '#FFFFFF',
  };
}

/** Synchronous accessor — safe to call from non-React modules (e.g. canvas generator). */
export function getShareCardThemeSync(): ResolvedShareCardTheme {
  return resolveShareCardTheme(read());
}

export function useShareCardTheme() {
  const [theme, setThemeState] = useState<ShareCardTheme>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setThemeState(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((t: ShareCardTheme) => {
    write(t);
    setThemeState(t);
  }, []);

  const reset = useCallback(() => {
    write(DEFAULT);
    setThemeState(DEFAULT);
  }, []);

  return { theme, setTheme, reset, resolved: resolveShareCardTheme(theme) };
}
