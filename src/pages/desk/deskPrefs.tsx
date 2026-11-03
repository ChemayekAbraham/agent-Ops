import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

export type Density = 'compact' | 'comfortable';

type Prefs = {
  /** Board mode: a dark, large-type wall display. Driven by ?board=1 so a screen can be bookmarked straight into it. */
  board: boolean;
  setBoard: (on: boolean) => void;
  density: Density;
  setDensity: (d: Density) => void;
  /** Auto-rotation through the desks. Off by default; only offered in board mode. */
  rotate: boolean;
  setRotate: (on: boolean) => void;
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

  const value = useMemo<Prefs>(
    () => ({ board, setBoard, density, setDensity, rotate, setRotate }),
    [board, setBoard, density, setDensity, rotate, setRotate],
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
