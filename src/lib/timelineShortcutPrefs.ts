// Persisted user-customizable keyboard shortcuts for the reconciliation
// timeline flagged-row navigation. Stored in localStorage so preferences
// survive reloads and are shared across every TimelineTable instance.
import { useEffect, useState } from 'react';

export type TimelineShortcutAction = 'jump' | 'next' | 'prev' | 'first' | 'last';

export type TimelineShortcutPrefs = Record<TimelineShortcutAction, string[]>;

export const DEFAULT_TIMELINE_SHORTCUTS: TimelineShortcutPrefs = {
  jump: ['j'],
  next: ['n', ']'],
  prev: ['p', '['],
  first: ['Home'],
  last: ['End'],
};

export const TIMELINE_SHORTCUT_LABELS: Record<TimelineShortcutAction, string> = {
  jump: 'Jump to highlighted',
  next: 'Next flagged',
  prev: 'Previous flagged',
  first: 'First flagged',
  last: 'Last flagged',
};

const STORAGE_KEY = 'welile:timeline-shortcuts:v1';
const listeners = new Set<(p: TimelineShortcutPrefs) => void>();
let cached: TimelineShortcutPrefs | null = null;

function normalizeKey(k: string): string {
  if (!k) return '';
  if (k.length === 1) return k.toLowerCase();
  return k;
}

function sanitize(input: Partial<TimelineShortcutPrefs> | null | undefined): TimelineShortcutPrefs {
  const out: TimelineShortcutPrefs = { ...DEFAULT_TIMELINE_SHORTCUTS };
  if (!input) return out;
  (Object.keys(DEFAULT_TIMELINE_SHORTCUTS) as TimelineShortcutAction[]).forEach((a) => {
    const raw = input[a];
    if (Array.isArray(raw)) {
      const cleaned = Array.from(new Set(raw.map(normalizeKey).filter(Boolean)));
      if (cleaned.length > 0) out[a] = cleaned;
    }
  });
  return out;
}

export function loadTimelineShortcuts(): TimelineShortcutPrefs {
  if (cached) return cached;
  if (typeof window === 'undefined') return { ...DEFAULT_TIMELINE_SHORTCUTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cached = sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    cached = { ...DEFAULT_TIMELINE_SHORTCUTS };
  }
  return cached;
}

export function saveTimelineShortcuts(next: TimelineShortcutPrefs): TimelineShortcutPrefs {
  const clean = sanitize(next);
  cached = clean;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    }
  } catch {
    /* ignore quota errors */
  }
  listeners.forEach((fn) => fn(clean));
  return clean;
}

export function resetTimelineShortcuts(): TimelineShortcutPrefs {
  return saveTimelineShortcuts({ ...DEFAULT_TIMELINE_SHORTCUTS });
}

export function matchTimelineShortcut(
  key: string,
  prefs: TimelineShortcutPrefs,
): TimelineShortcutAction | null {
  const norm = normalizeKey(key);
  for (const action of Object.keys(prefs) as TimelineShortcutAction[]) {
    if (prefs[action].some((k) => normalizeKey(k) === norm)) return action;
  }
  return null;
}

export function formatShortcutKey(k: string): string {
  if (!k) return '';
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toUpperCase();
  return k;
}

export function useTimelineShortcuts(): TimelineShortcutPrefs {
  const [prefs, setPrefs] = useState<TimelineShortcutPrefs>(() => loadTimelineShortcuts());
  useEffect(() => {
    const fn = (p: TimelineShortcutPrefs) => setPrefs(p);
    listeners.add(fn);
    // Cross-tab sync via storage event.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        cached = null;
        setPrefs(loadTimelineShortcuts());
      }
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(fn);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  }, []);
  return prefs;
}