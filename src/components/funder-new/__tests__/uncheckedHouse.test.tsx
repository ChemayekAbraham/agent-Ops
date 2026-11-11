import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import { FunderNewHouseCard } from '../FunderNewHouseCard';
import { FunderV3HouseCard } from '@/components/funder-v3/FunderV3HouseCard';
import { HOUSE_NOT_CHECKED_TEXT, isUncheckedEmptyHouse } from '../utils';
import { makeEmptyHouse, makeReadyPlan } from '@/components/funder-v3/__fixtures__/funderV3Fixtures';

afterEach(() => cleanup());

const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>{ui}</QueryClientProvider>);

const noop = () => {};
const common = { saved: false, selected: false, distance: null, onSave: noop, onSelect: noop, onDetail: noop };

describe('empty houses Welile has not checked (house_listings.verified = false)', () => {
  it('only an empty house with verified = false counts as unchecked', () => {
    expect(isUncheckedEmptyHouse('empty', { ...makeEmptyHouse(0), verified: false })).toBe(true);
    expect(isUncheckedEmptyHouse('empty', { ...makeEmptyHouse(0), verified: true })).toBe(false);
    expect(isUncheckedEmptyHouse('ready', makeReadyPlan(0))).toBe(false);
  });

  for (const [name, Card] of [['legacy', FunderNewHouseCard], ['V3', FunderV3HouseCard]] as const) {
    it(`${name} card: unchecked house shows the grey line, no Fund button, never "Pending verification"`, () => {
      render(<Card {...common} cardId="empty:house-0" category="empty" item={{ ...makeEmptyHouse(0), verified: false }} />);
      expect(screen.getByText(HOUSE_NOT_CHECKED_TEXT)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Fund this House/i })).toBeNull();
      expect(screen.queryByText(/Pending verification/i)).toBeNull();
      expect(screen.queryByText('Verified House')).toBeNull();
      // Details stays, and the save icon where the card has one (the legacy card's was removed on lovable).
      expect(screen.getAllByRole('button', { name: /full details/i }).length).toBeGreaterThan(0);
      if (name === 'V3') expect(screen.getByRole('button', { name: /Save .* for later/ })).toBeTruthy();
    });

    it(`${name} card: a verified empty house keeps "Fund this House"`, () => {
      render(<Card {...common} cardId="empty:house-1" category="empty" item={{ ...makeEmptyHouse(1), verified: true }} />);
      expect(screen.getByRole('button', { name: /Fund this House/i })).toBeTruthy();
      expect(screen.queryByText(HOUSE_NOT_CHECKED_TEXT)).toBeNull();
      expect(screen.queryByText(/Pending verification/i)).toBeNull();
    });
  }
});
