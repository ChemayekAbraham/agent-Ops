import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

export type Density = 'compact' | 'comfortable';

/**
 * The desks open light and stay light until someone says otherwise.
 *
 * The device setting is deliberately not consulted: the desks are a shared
 * screen as often as a personal one, and a board that changed colour because
 * of whose laptop it was on would be harder to talk about, not easier.
 */
export type Theme = 'light' | 'dark';
export const DEFAULT_THEME: Theme = 'light';
export const THEME_KEY = 'desk-theme';

/**
 * The theme a desk renders in, on every desk:
 *   no saved choice  → light (the device's dark setting is never consulted)
 *   a saved choice   → that choice
 *   Board mode       → dark, always
 */
export function resolveDeskTheme(board: boolean, saved: string | null | undefined): Theme {
  if (board) return 'dark';
  return saved === 'light' || saved === 'dark' ? saved : DEFAULT_THEME;
}

type Prefs = {
  /** Board mode: a dark, large-type wall display. Driven by ?board=1 so a screen can be bookmarked straight into it. */
  board: boolean;
  setBoard: (on: boolean) => void;
  density: Density;
  setDensity: (d: Density) => void;
  /** Auto-rotation through the desks. Off by default; only offered in board mode. */
  rotate: boolean;
  setRotate: (on: boolean) => void;
  /** The viewer's saved theme (light until they choose). Board mode ignores it. */
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** What `.desk-root` should carry right now: `theme`, or dark in Board mode. */
  rootTheme: Theme;
};

const Ctx = createContext<Prefs | null>(null);

function readStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage: the preference just does not persist */
  }
}

export function DeskPrefsProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const board = params.get('board') === '1';
  const [density, setDensityState] = useState<Density>(() => readStored('desk-density', 'comfortable', ['compact', 'comfortable'] as const));
  const [rotate, setRotateState] = useState<boolean>(() => readStored('desk-rotate', 'off', ['on', 'off'] as const) === 'on');

  const setBoard = useCallback(
    (on: boolean) => {
      const next = new URLSearchParams(params);
      if (on) next.set('board', '1');
      else next.delete('board');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    store('desk-density', d);
  }, []);

  const setRotate = useCallback((on: boolean) => {
    setRotateState(on);
    store('desk-rotate', on ? 'on' : 'off');
  }, []);

  // A saved choice beats the default; anything else falls back to light.
  const [theme, setThemeState] = useState<Theme>(() =>
    resolveDeskTheme(false, readStored<string>(THEME_KEY, '', ['light', 'dark'])),
  );

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    store(THEME_KEY, t);
  }, []);

  const rootTheme = resolveDeskTheme(board, theme);

  const value = useMemo<Prefs>(
    () => ({ board, setBoard, density, setDensity, rotate, setRotate, theme, setTheme, rootTheme }),
    [board, setBoard, density, setDensity, rotate, setRotate, theme, setTheme, rootTheme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDeskPrefs(): Prefs {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDeskPrefs must be used inside DeskPrefsProvider');
  return v;
}

const KAMPALA = 'Africa/Kampala';

/** Isolated so the whole board does not re-render once a second. */
export function KampalaClock({ className = '' }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className={`tabular-nums ${className}`}>
      {now.toLocaleTimeString('en-GB', { timeZone: KAMPALA, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      <span className="ml-1.5 text-[0.75em] opacity-70">Kampala</span>
    </span>
  );
}

export function clockTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: KAMPALA, hour: '2-digit', minute: '2-digit' });
}
