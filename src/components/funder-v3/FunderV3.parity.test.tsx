import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// The live hero reads the empty-houses switch from auth; pin it on for both sides.
vi.mock('@/hooks/useFunderEmptyHousesSwitch', () => ({ useFunderEmptyHousesAllowed: () => true }));
// The launcher rules live next to the assistant, which imports the backend client; no network here.
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() }, auth: { onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })), getSession: vi.fn() } } }));

import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderNewHero } from '@/components/funder-new/FunderNewHero';
import { FunderV3HouseCard } from './FunderV3HouseCard';
import { FunderV3Hero } from './FunderV3Hero';
import { countLabel, readChipDismissed } from './FunderV3HousesScreen';
import { columnsForWidth, cardIdOf } from './FunderV3HousesList';
import { layoutModeFor } from './useLayoutMode';
import { nearestSnap, snapHeights } from './FunderV3Sheet';
import { launcherHidden, isFunderRoute } from '@/components/FloatingToolbar';
import { FIXTURE_DEVICE, FIXTURE_SUMMARY, makeFeed } from './__fixtures__/funderV3Fixtures';
import { itemCoordinates } from '@/components/funder-new/utils';
import { straightLineDistance } from '@/components/funder-new/distance';

/**
 * Every number in a rendered block, in reading order: money, counts, distances,
 * percentages. Separators are kept, so "UGX 1,234,567" and "1.2M" stay distinct.
 */
function numericStrings(root: HTMLElement): string[] {
  const text = (root.textContent ?? '').replace(/\s+/g, ' ');
  return text.match(/[A-Z]{3}\s?[\d.,]+[KMB]?|[\d][\d.,]*\s?(?:km|m|%|\+)?/g) ?? [];
}

/** Visible words that matter for the card contract (badge, CTA, return line). */
function keyCopy(root: HTMLElement): string[] {
  const text = (root.textContent ?? '').replace(/\s+/g, ' ');
  const phrases = ['Pending verification', 'Verified tenant', 'Fund this House', 'Selected', 'Support this home', 'monthly', 'Details', 'About'];
  return phrases.filter((phrase) => text.includes(phrase));
}

const feed = makeFeed(16, 4);

describe('funder V3 — number parity with the live screens', () => {
  beforeEach(() => cleanup());

  it.each(feed.map((entry, index) => [index, entry] as const))('card %i: every number and money string matches the live card', (_index, entry) => {
    const coords = itemCoordinates(entry.item, entry.category);
    const distance = coords ? straightLineDistance(FIXTURE_DEVICE, coords) : null;
    for (const selected of [false, true]) {
      const common = { category: entry.category, item: entry.item, saved: false, selected, distance, onSave: () => {}, onSelect: () => {}, onDetail: () => {} };
      const live = render(<FunderNewHouseCard {...common} />);
      const v3 = render(<FunderV3HouseCard {...common} cardId={cardIdOf(entry)} />);
      const liveNumbers = numericStrings(live.container);
      expect(liveNumbers.length).toBeGreaterThan(0);
      expect(numericStrings(v3.container)).toEqual(liveNumbers);
      expect(keyCopy(v3.container)).toEqual(keyCopy(live.container));
      cleanup();
    }
  });

  it('hero: market total, house count and the 15% line match the live hero', () => {
    const live = render(<FunderNewHero summary={FIXTURE_SUMMARY} isLoading={false} hasError={false} onHowItWorks={() => {}} onOpen={() => {}} />);
    const v3 = render(<FunderV3Hero summary={FIXTURE_SUMMARY} isLoading={false} hasError={false} emptyHousesAllowed onOpen={() => {}} />);
    const liveNumbers = numericStrings(live.container);
    expect(liveNumbers).toContain('15%');
    expect(liveNumbers.some((n) => n.includes('1,234,567,890'))).toBe(true);
    expect(numericStrings(v3.container)).toEqual(liveNumbers);
  });

  it('hero: the "total unavailable" state reads the same', () => {
    const live = render(<FunderNewHero summary={undefined} isLoading={false} hasError onHowItWorks={() => {}} />);
    const v3 = render(<FunderV3Hero summary={undefined} isLoading={false} hasError emptyHousesAllowed onOpen={() => {}} />);
    expect(v3.container.textContent).toContain('The live market total is unavailable right now.');
    expect(live.container.textContent).toContain('The live market total is unavailable right now.');
    expect(numericStrings(v3.container)).toEqual(numericStrings(live.container));
  });

  it('hero: V3 adds an explicit "See houses to fund" button', () => {
    const onOpen = vi.fn();
    const v3 = render(<FunderV3Hero summary={FIXTURE_SUMMARY} isLoading={false} hasError={false} emptyHousesAllowed onOpen={onOpen} />);
    const button = v3.getByRole('button', { name: /See houses to fund/ });
    button.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('funder V3 — presentation helpers', () => {
  it('count chip uses the existing filtered total ("12 of 2,534")', () => {
    expect(countLabel(12, 2534)).toBe('12 of 2,534');
    expect(countLabel(0, 0)).toBe('0 of 0');
  });

  it('layout modes switch at 640 and 1024', () => {
    expect(layoutModeFor(320)).toBe('compact');
    expect(layoutModeFor(639)).toBe('compact');
    expect(layoutModeFor(640)).toBe('medium');
    expect(layoutModeFor(1023)).toBe('medium');
    expect(layoutModeFor(1024)).toBe('expanded');
    expect(layoutModeFor(1920)).toBe('expanded');
  });

  it('list columns follow the list width, not the viewport', () => {
    expect(columnsForWidth(380)).toBe(1);
    expect(columnsForWidth(560)).toBe(2);
    expect(columnsForWidth(720)).toBe(2);
    expect(columnsForWidth(1100)).toBe(3);
  });

  it('sheet snap heights are recomputed from the live viewport', () => {
    const portrait = snapHeights(844, 76);
    expect(portrait).toEqual({ peek: 96, half: 422, full: 768 });
    const landscape = snapHeights(390, 76);
    expect(landscape.half).toBe(195);
    expect(landscape.full).toBe(314);
    // Keyboard open: much shorter visible viewport.
    expect(snapHeights(420, 76).full).toBe(344);
  });

  it('a released drag settles on the nearest snap, a flick moves one snap', () => {
    const h = snapHeights(800, 76);
    expect(nearestSnap(110, h)).toBe('peek');
    expect(nearestSnap(420, h)).toBe('half');
    expect(nearestSnap(700, h)).toBe('full');
    expect(nearestSnap(430, h, -1)).toBe('full');
    expect(nearestSnap(390, h, 1)).toBe('peek');
  });

  it('location chip dismissal lasts 7 days', () => {
    // Some Node builds expose a broken global localStorage under jsdom; use a plain in-memory one.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    Object.defineProperty(window, 'localStorage', { value: globalThis.localStorage, configurable: true });
    const now = Date.now();
    window.localStorage.setItem('welile.funder-v3.location-chip-dismissed-at', String(now - 6 * 86400000));
    expect(readChipDismissed(now)).toBe(true);
    window.localStorage.setItem('welile.funder-v3.location-chip-dismissed-at', String(now - 8 * 86400000));
    expect(readChipDismissed(now)).toBe(false);
    window.localStorage.removeItem('welile.funder-v3.location-chip-dismissed-at');
    expect(readChipDismissed(now)).toBe(false);
  });

  it('assistant launcher hides on full screen maps and behind dialogs', () => {
    const base = { isDashboardRoute: true, overlayOpen: false, mapExpanded: false, assistantChatOpen: false };
    expect(launcherHidden(base)).toBe(false);
    expect(launcherHidden({ ...base, mapExpanded: true })).toBe(true);
    expect(launcherHidden({ ...base, overlayOpen: true })).toBe(true);
    expect(launcherHidden({ ...base, overlayOpen: true, assistantChatOpen: true })).toBe(false);
    expect(launcherHidden({ ...base, isDashboardRoute: false })).toBe(true);
    expect(isFunderRoute('/dashboard/funder')).toBe(true);
    expect(isFunderRoute('/dashboard/funder-v3')).toBe(true);
    expect(isFunderRoute('/dashboard/agent')).toBe(false);
  });
});
