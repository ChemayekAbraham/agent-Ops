import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import { FunderNewHouseCard } from '../FunderNewHouseCard';
import { FunderV3HouseCard } from '@/components/funder-v3/FunderV3HouseCard';
import { isUncheckedEmptyHouse, requestRef } from '../utils';
import { FunderBoardItemCard } from '../FunderBoardItemCard';
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
    it(`${name} card: unchecked house has no Fund button and no action line, never "Pending verification"`, () => {
      const { container } = render(<Card {...common} cardId="empty:house-0" category="empty" item={{ ...makeEmptyHouse(0), verified: false }} />);
      expect(container.querySelector('[data-unchecked="true"]')).not.toBeNull();
      expect(screen.queryByText(/not yet checked/i)).toBeNull();
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
      expect(screen.queryByText(/not yet checked/i)).toBeNull();
      expect(screen.queryByText(/Pending verification/i)).toBeNull();
    });
  }
});

describe('COO/CEO Incomplete chip on Verified cards', () => {
  for (const [name, Card] of [['legacy', FunderNewHouseCard], ['V3', FunderV3HouseCard]] as const) {
    it(`${name} card: shows "Incomplete: …" when the list has items, nothing for null or empty`, () => {
      const { unmount } = render(<Card {...common} cardId="ready:plan-0" category="ready" item={makeReadyPlan(0)} incomplete={['family size', 'work / business']} />);
      expect(screen.getByTestId('fv3-incomplete-chip').textContent).toBe('Incomplete: family size, work / business');
      unmount();
      for (const none of [null, []]) {
        const r = render(<Card {...common} cardId="ready:plan-0" category="ready" item={makeReadyPlan(0)} incomplete={none} />);
        expect(screen.queryByTestId('fv3-incomplete-chip')).toBeNull();
        r.unmount();
      }
    });
  }

  it('V3 card: the chip sits above the demote control', () => {
    render(<FunderV3HouseCard {...common} cardId="ready:plan-0" category="ready" item={makeReadyPlan(0)} incomplete={['family size']} demoteMode onDemoteToggle={noop} />);
    const chip = screen.getByTestId('fv3-incomplete-chip');
    const demote = screen.getByTestId('fv3-demote-check');
    expect(chip.compareDocumentPosition(demote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Ref line on rent-request cards (match a card to its desk row)', () => {
  it('requestRef: first 8 of the request id, upper case; null without an id', () => {
    expect(requestRef('3f2a9c1b-77de-4a10-9b2c-0d1e2f3a4b5c')).toBe('Ref 3F2A9C1B');
    expect(requestRef(null)).toBeNull();
    expect(requestRef('')).toBeNull();
  });

  for (const [name, Card] of [['legacy', FunderNewHouseCard], ['V3', FunderV3HouseCard]] as const) {
    it(`${name} card: a Rent Plan shows "Ref …" under the title; an empty house never does`, () => {
      const plan = { ...makeReadyPlan(0), rent_request_id: '3f2a9c1b-77de-4a10-9b2c-0d1e2f3a4b5c' };
      const r = render(<Card {...common} cardId="ready:x" category="ready" item={plan} />);
      expect(screen.getByTestId('fv3-ref').textContent).toBe('Ref 3F2A9C1B');
      r.unmount();
      render(<Card {...common} cardId="empty:house-0" category="empty" item={{ ...makeEmptyHouse(0), verified: true }} />);
      expect(screen.queryByTestId('fv3-ref')).toBeNull();
      expect(screen.queryByText(/^Ref /)).toBeNull();
    });
  }

  it('view-only board card: shows the Ref too', () => {
    render(
      <FunderBoardItemCard
        cardId="board:x"
        distance={null}
        item={{ id: 'ab12cd34-0000-4000-8000-000000000000', tag: 'booked', selectable: false, held: false, tenantFirstName: null, houseCategory: 'Single Room', city: 'Kira', mainPhoto: null, photos: [], rentAmount: 300000, durationDays: 30, dailyRepayment: null, lat: null, lng: null, sortAt: null, incomplete: null }}
      />,
    );
    expect(screen.getByTestId('fv3-ref').textContent).toBe('Ref AB12CD34');
  });
});
