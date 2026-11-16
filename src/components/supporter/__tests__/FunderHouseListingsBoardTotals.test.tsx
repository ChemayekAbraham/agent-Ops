import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { FunderNewReadyPlan } from '@/components/funder-new/types';
import { resetBookedByMe } from '@/components/funder-new/funderListRefresh';

/**
 * E72b header totals on the legacy funders houses list: "{n} ready to fund ·
 * UGX {total}" and "{n} verified · {n} pending verification" show only when
 * funders_board_can_demote() is true (COO/CEO). Funders see the grouped list
 * and its group headers without them.
 *
 * Funded requests (bug 16 Nov, ref F51F93B1): every fundable card comes from
 * the fundable plans read; after a fund the card leaves at once and the lists
 * refetch; a stale list never shows "Fund this House" on a funded request.
 */

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() })),
    removeChannel: vi.fn(),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'viewer-1' }, session: {}, loading: false }) }));
vi.mock('@/hooks/useFeaturePreview', () => ({ FEATURE_FUNDERS_BOARD_TAGS: 'funders_board_tags', useFeaturePreview: () => true }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ profile: { full_name: 'Test Funder', email: null, phone: null } }) }));
vi.mock('@/hooks/wallet/useWalletBalance', () => ({ useWalletBalance: () => ({ isLoading: false, error: null, floatBalance: 5_000_000 }) }));
vi.mock('@/hooks/useSelfSupportFeePolicy', () => ({ useSelfSupportFeePolicy: () => ({ pay: (rent: number) => rent }) }));
vi.mock('@/hooks/useFunderSavedItems', () => ({ useFunderSavedItems: () => ({ saved: { empty: [], ready: [] }, toggleSave: vi.fn() }) }));
// The chooser answers "through Welile" at once.
vi.mock('@/components/supporter/FunderFundChooser', () => ({ useRentPlanFundChoice: () => ({ ask: (_t: unknown, next: () => void) => next(), chooser: null }) }));
vi.mock('@/components/funder-preview/funderOperationalFloat', () => ({ requireFunderOperationalFloat: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/funder-preview/useFunderPreviewSupport', () => ({ useFunderFloatAvailable: () => ({ isLoading: false, isError: false, error: null, data: 5_000_000 }) }));

const plan = (id: string): FunderNewReadyPlan =>
  ({ rent_request_id: id, funding_amount: 400000, house_category: 'Single Room', request_city: 'Kira', house_image_urls: null, held_by: null }) as unknown as FunderNewReadyPlan;
const infinite = (items: unknown[], total: number) => ({
  data: { pages: [{ items, total }] },
  isLoading: false,
  isFetching: false,
  isFetchingNextPage: false,
  isError: false,
  error: null,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
});
// The fundable plans read (partner_self_list_fundable_plans): plan "a" only. "late" is Verified on the
// board but no longer in the read (someone took it). Tests may swap in a stale list.
let readyPlans: FunderNewReadyPlan[] = [];
vi.mock('@/components/funder-new/useFunderNewOpportunities', () => ({
  useFunderNewReadyPlans: () => infinite(readyPlans, readyPlans.length),
  useFunderNewEmptyHouses: () => infinite([], 0),
  useFunderNewEmptyHousesPage: () => ({ data: { items: [], total: 0 }, isFetching: false }),
  useFunderNewMarketSummary: () => ({ data: { houseCount: 0, totalRentNeeded: 0, avgMonthlyRent: 0, districts: [] } }),
}));

const boardItem = (id: string, tag: string, extra: Record<string, unknown> = {}) => ({
  kind: 'rent_request', id, tag, selectable: tag === 'verified', held: false, house_category: 'Single Room', city: 'Kira', rent_amount: 400000, ...extra,
});
const BOARD = {
  items: [
    boardItem('a', 'verified', { incomplete: ['family size', 'LC1 (letter or phone confirmation)'] }),
    boardItem('late', 'verified', { incomplete: [] }),
    boardItem('held', 'verified', { selectable: false, held: true, incomplete: ['photo review (3+ approved, main photo)'] }),
    boardItem('b1', 'booked'),
    boardItem('p1', 'pending_verification'),
  ],
  counts: { verified: 3, verified_ugx: 1200000, booked: 1, funded: 0, pending_verification: 1, pending_verification_ugx: 400000, ready_total: 4, ready_total_ugx: 1600000 },
};

/** Like the server: once "a" is funded, the board lists it as Booked. */
function mockRpc(canDemote: boolean) {
  let funded = false;
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'funders_board_items') {
      if (!funded) return { data: BOARD, error: null };
      return {
        data: {
          items: BOARD.items.map((i) => (i.id === 'a' ? { ...i, tag: 'booked', selectable: false, incomplete: null } : i)),
          counts: { ...BOARD.counts, verified: 2, verified_ugx: 800000, booked: 2, ready_total: 3, ready_total_ugx: 1200000 },
        },
        error: null,
      };
    }
    if (fn === 'funders_board_can_demote') return { data: canDemote, error: null };
    if (fn === 'funder_support_tenant_direct') {
      funded = true;
      return { data: { commitment_id: 'c-1' }, error: null };
    }
    return { data: null, error: null };
  });
}

async function renderSection() {
  const { FunderHouseListingsSection } = await import('../FunderHouseListingsSection');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FunderHouseListingsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByTestId('board-groups');
}

beforeEach(() => {
  rpc.mockReset();
  readyPlans = [plan('a')];
  resetBookedByMe();
});
afterEach(() => cleanup());

// The first render loads the whole section module cold (about 5 s), so allow more than the default.
describe('funders houses list: header totals are COO/CEO only', { timeout: 20_000 }, () => {
  it('funder view: grouped list with group headers, no totals', async () => {
    mockRpc(false);
    await renderSection();
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('funders_board_can_demote', {}));
    expect(screen.queryByTestId('board-headline')).toBeNull();
    expect(screen.queryByTestId('board-subline')).toBeNull();
    expect(screen.queryByText(/ready to fund ·/)).toBeNull();
    expect(screen.queryByText(/pending verification$/)).toBeNull();
    // Three tabs. Verified opens first and carries its Booked plans; Unverified holds pending verification.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Verified4', 'Unverified1', 'Empty houses0']);
    expect(document.querySelectorAll('[data-board-group]').length).toBe(2);
    // "late" is gone from the fundable plans read, so it shows as Booked, not Verified.
    expect(screen.getByRole('region', { name: 'Verified, 2' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Booked, 2' })).toBeTruthy();
    fireEvent.click(tabs[1]);
    expect(screen.getByRole('region', { name: 'Pending verification, 1' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Verified, 2' })).toBeNull();
  });

  it('COO/CEO view: both totals show', async () => {
    mockRpc(true);
    await renderSection();
    expect(await screen.findByTestId('board-headline')).toHaveTextContent('4 ready to fund · UGX 1,600,000');
    expect(screen.getByTestId('board-subline')).toHaveTextContent('3 verified · 1 pending verification');
  });

  it('COO/CEO view: Verified cards with something missing show the red Incomplete chip', async () => {
    mockRpc(true);
    await renderSection();
    await screen.findByTestId('board-headline');
    const chips = screen.getAllByTestId('fv3-incomplete-chip').map((el) => el.textContent);
    expect(chips).toEqual(['Incomplete: family size, LC1 (letter or phone confirmation)', 'Incomplete: photo review (3+ approved, main photo)']);
  });

  it('funder view: never an Incomplete chip, even if a list arrived', async () => {
    // The server sends incomplete as null to funders; the list drops it as well.
    mockRpc(false);
    await renderSection();
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('funders_board_can_demote', {}));
    expect(screen.queryByTestId('fv3-incomplete-chip')).toBeNull();
    expect(screen.queryByText(/Incomplete:/)).toBeNull();
  });

  it('every fundable card comes from the fundable plans read: one that left it is never fundable', async () => {
    mockRpc(false);
    await renderSection();
    const verified = screen.getByRole('region', { name: 'Verified, 2' });
    expect(within(verified).getAllByRole('button', { name: /Fund this House/i })).toHaveLength(1);
    expect(within(verified).queryByText('View only.')).toBeNull();
    expect(within(verified).getAllByTestId('board-item-card').map((el) => el.getAttribute('data-card-id'))).toEqual(['board:held']);
    const booked = screen.getByRole('region', { name: 'Booked, 2' });
    expect(within(booked).getAllByTestId('board-item-card').map((el) => el.getAttribute('data-card-id'))).toEqual(['board:late', 'board:b1']);
    expect(within(booked).queryByRole('button', { name: /Fund this House/i })).toBeNull();
  });

  it('a stale list containing a funded request does not render the Fund button', async () => {
    // The fundable list is stale: it still has "b1", which the board says is Booked, and a plan marked funded.
    readyPlans = [plan('a'), plan('b1'), { ...plan('gone'), status: 'funded' } as unknown as FunderNewReadyPlan];
    mockRpc(false);
    await renderSection();
    expect(screen.getAllByRole('button', { name: /Fund this House/i })).toHaveLength(1);
    expect(document.querySelector('[data-card-id="ready:b1"]')).toBeNull();
    expect(document.querySelector('[data-card-id="ready:gone"]')).toBeNull();
  });

  it('Fund: the card disappears at once, the counts drop, and the lists refetch', async () => {
    mockRpc(true);
    await renderSection();
    expect(await screen.findByTestId('board-headline')).toHaveTextContent('4 ready to fund · UGX 1,600,000');
    const before = rpc.mock.calls.filter(([fn]) => fn === 'funders_board_items').length;
    fireEvent.click(within(screen.getByRole('region', { name: 'Verified, 2' })).getByRole('button', { name: /Fund this House/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Fund this plan/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and support/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('funder_support_tenant_direct', expect.objectContaining({ p_rent_request_ids: ['a'] })));
    // Gone from Verified at once: no Fund button left, the group count drops.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Fund this House/i, hidden: true })).toBeNull());
    // (The success dialog stays open, so read the group straight from the page.)
    expect(document.querySelector('[data-board-group="verified"]')?.getAttribute('aria-label')).toBe('Verified, 1');
    // The funder sees it as theirs.
    const mine = document.querySelector('[data-card-id="board:a"]') as HTMLElement;
    expect(mine.getAttribute('data-tag')).toBe('booked');
    expect(within(mine).getByTestId('board-item-note')).toHaveTextContent('Booked — waiting for landlord payment');
    // Counts drop, and the board read is fetched again.
    await waitFor(() => expect(document.querySelector('[data-testid="board-headline"]')).toHaveTextContent('3 ready to fund · UGX 1,200,000'));
    await waitFor(() => expect(rpc.mock.calls.filter(([fn]) => fn === 'funders_board_items').length).toBeGreaterThan(before));
  });
});
