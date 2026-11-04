import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

export type Density = 'compact' | 'comfortable';

/** What the viewer chose. 'system' follows the device; the other two override it. */
export type ThemeChoice = 'system' | 'light' | 'dark';
/** What that resolves to once the device setting is read. */
export type Theme = 'light' | 'dark';

/** The device's own setting, read at call time so a test can run without matchMedia. */
function deviceTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
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
  /** The viewer's choice, which may be "follow the device". */
  themeChoice: ThemeChoice;
  setThemeChoice: (t: ThemeChoice) => void;
  /** The choice resolved against the device. Board mode ignores this and stays dark. */
  theme: Theme;
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

  const [themeChoice, setThemeChoiceState] = useState<ThemeChoice>(() =>
    readStored('desk-theme', 'system', ['system', 'light', 'dark'] as const),
  );
  const [device, setDevice] = useState<Theme>(deviceTheme);

  // Follow the device while the choice is 'system' — someone switching their
  // laptop to night mode should not have to reload the desk.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setDevice(mq.matches ? 'light' : 'dark');
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setThemeChoice = useCallback((t: ThemeChoice) => {
    setThemeChoiceState(t);
    store('desk-theme', t);
  }, []);

  const theme: Theme = themeChoice === 'system' ? device : themeChoice;

  const value = useMemo<Prefs>(
    () => ({ board, setBoard, density, setDensity, rotate, setRotate, themeChoice, setThemeChoice, theme }),
    [board, setBoard, density, setDensity, rotate, setRotate, themeChoice, setThemeChoice, theme],
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
