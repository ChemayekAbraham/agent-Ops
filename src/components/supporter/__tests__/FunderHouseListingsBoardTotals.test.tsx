import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { FunderNewReadyPlan } from '@/components/funder-new/types';

/**
 * E72b header totals on the legacy funders houses list: "{n} ready to fund ·
 * UGX {total}" and "{n} verified · {n} pending verification" show only when
 * funders_board_can_demote() is true (COO/CEO). Funders see the grouped list
 * and its group headers without them. A selectable Verified item whose plan
 * has not loaded is still a fundable card, never "View only".
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
vi.mock('@/components/supporter/FunderFundChooser', () => ({ useRentPlanFundChoice: () => ({ ask: vi.fn(), dialog: null, element: null }) }));

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
vi.mock('@/components/funder-new/useFunderNewOpportunities', () => ({
  // Only the first page of fundable plans has loaded: plan "a". Plan "late" is selectable on the board.
  useFunderNewReadyPlans: () => infinite([plan('a')], 2),
  useFunderNewEmptyHouses: () => infinite([], 0),
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

function mockRpc(canDemote: boolean) {
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'funders_board_items') return { data: BOARD, error: null };
    if (fn === 'funders_board_can_demote') return { data: canDemote, error: null };
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

beforeEach(() => rpc.mockReset());
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
    // Group headers stay as they are.
    expect(document.querySelectorAll('[data-board-group]').length).toBe(3);
    expect(screen.getByRole('region', { name: 'Verified, 3' })).toBeTruthy();
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

  it("a selectable Verified item follows the server's selectable: fundable before its plan loads, never \"View only\"", async () => {
    mockRpc(false);
    await renderSection();
    const verified = screen.getByRole('region', { name: 'Verified, 3' });
    // "a" (loaded) and "late" (not loaded yet) both get Fund this House; only the held one is view only.
    expect(within(verified).getAllByRole('button', { name: /Fund this House/i })).toHaveLength(2);
    expect(within(verified).queryByText('View only.')).toBeNull();
    expect(within(verified).getAllByTestId('board-item-card').map((el) => el.getAttribute('data-card-id'))).toEqual(['board:held']);
    expect(within(verified).getByTestId('board-item-note')).toHaveTextContent('Held by a funder for now — view only.');
  });
});
