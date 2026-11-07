import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DeskPrefsProvider, THEME_KEY, resolveDeskTheme, useDeskPrefs } from '../deskPrefs';

/** Shows what the provider decided, and offers the toggle's action. */
function Probe() {
  const { theme, rootTheme, setTheme } = useDeskPrefs();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="root">{rootTheme}</span>
      <button type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
        toggle
      </button>
    </div>
  );
}

const mount = (url = '/desk/coo') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <DeskPrefsProvider>
        <Probe />
      </DeskPrefsProvider>
    </MemoryRouter>,
  );

/** An in-memory localStorage: the test environment does not provide one. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  // A device that prefers dark: the desks must not follow it.
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark'), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveDeskTheme', () => {
  it('no saved choice → light', () => {
    expect(resolveDeskTheme(false, null)).toBe('light');
    expect(resolveDeskTheme(false, undefined)).toBe('light');
    expect(resolveDeskTheme(false, '')).toBe('light');
    expect(resolveDeskTheme(false, 'sepia')).toBe('light');
  });
  it('a saved choice wins', () => {
    expect(resolveDeskTheme(false, 'dark')).toBe('dark');
    expect(resolveDeskTheme(false, 'light')).toBe('light');
  });
  it('Board mode is always dark', () => {
    expect(resolveDeskTheme(true, null)).toBe('dark');
    expect(resolveDeskTheme(true, 'light')).toBe('dark');
    expect(resolveDeskTheme(true, 'dark')).toBe('dark');
  });
});

describe('DeskPrefsProvider', () => {
  it('opens light with nothing saved, even on a dark-preferring device', () => {
    mount();
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(screen.getByTestId('root').textContent).toBe('light');
  });

  it('opens dark when dark was saved', () => {
    localStorage.setItem(THEME_KEY, 'dark');
    mount();
    expect(screen.getByTestId('root').textContent).toBe('dark');
  });

  it('Board mode renders dark even with light saved', () => {
    localStorage.setItem(THEME_KEY, 'light');
    mount('/desk/coo?board=1');
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(screen.getByTestId('root').textContent).toBe('dark');
  });

  it('the toggle remembers the choice', () => {
    mount();
    act(() => screen.getByRole('button', { name: 'toggle' }).click());
    expect(screen.getByTestId('root').textContent).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });
});
