import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));

import { DemotedPanel } from '../fundersBoard/DemotedPanel';
import { FundersBoardCounterCard } from '../cfo/FundersBoardCounterCard';
import { cooChips, isPushable, pushPlan, type CooRow } from '../CooBoard';

const AWAITING = [
  {
    id: 'd1', kind: 'rent_request', item_id: 'rr-00000001', short_id: 'rr-00000', tag: 'verified', tag_label: 'Verified', title: 'Achieng Grace', place: 'Kireka',
    amount: 1_250_000, reason_code: 'FB_PHOTOS_POOR', reason_label: 'Photos not good enough to show funders', reason_text: null,
    demoted_by_name: 'Agnes Namata', demoted_staff_ref: 'EMP-014', demoted_position: 'coo', demoted_at: '2026-11-09T08:00:00Z',
    days_waiting: 1.5, state: 'awaiting_level', current: 'partner_ops_approved', moved_by_system: false, photo: 'https://example.test/p.jpg',
  },
  {
    id: 'd2', kind: 'house_listing', item_id: 'h-00000002', short_id: 'h-000000', tag: 'empty_house', tag_label: 'Empty house', title: 'Single room', place: 'Ntinda, Kampala',
    amount: 300_000, reason_code: 'OTHER', reason_label: 'Reviewed weekly', reason_text: 'Landlord moved abroad last week',
    demoted_by_name: 'Robert CEO', demoted_staff_ref: 'EMP-001', demoted_position: 'ceo', demoted_at: '2026-11-08T08:00:00Z',
    days_waiting: 2, state: 'awaiting_level', current: 'off the board', moved_by_system: true, photo: null,
  },
];
const LEVELS = {
  rent_request: [
    { code: 'agent_ops', label: 'Agent Ops', hint: 'Back to Agent Ops (agent, items, photos)' },
    { code: 'coo', label: 'COO queue', hint: 'Stays in your graded queue to push later' },
    { code: 'restore', label: 'Back on the funders board', hint: 'Undo the demotion' },
  ],
  house_listing: [
    { code: 'parked', label: 'Parked off the board', hint: 'Kept, not shown to funders' },
    { code: 'restore', label: 'Back on the funders board', hint: 'Undo the demotion' },
  ],
};
const DECIDED = [{ ...AWAITING[1], id: 'd9', state: 'decided', level: 'parked', level_label: 'Parked off the board', level_by_name: 'Agnes Namata', level_staff_ref: 'EMP-014', level_at: '2026-11-09T09:00:00Z', days_waiting: null }];
const board = (over: Record<string, unknown> = {}) => ({ can_decide: true, awaiting: AWAITING, decided: DECIDED, levels: LEVELS, counts: { awaiting: 2, awaiting_ugx: 1_550_000, decided_in_period: 1 }, ...over });
const COUNTER = {
  houses_waiting: 137, amount_needed_ugx: 52_300_000, avg_monthly_rent: 381_752, baseline_houses: 140, baseline_amount_ugx: 53_000_000, frozen_at: '2026-11-09T05:00:00Z',
  added_by_push: 3, added_by_push_ugx: 1_800_000, restored: 1, restored_ugx: 300_000, removed: 7, removed_ugx: 2_800_000,
  awaiting_level: 2, awaiting_level_ugx: 1_550_000, verified_on_board: 41, verified_on_board_ugx: 22_100_000, last_change_at: '2026-11-09T09:00:00Z', switch_on: true,
};

function wrap(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string, args: Record<string, unknown>) => {
    if (fn === 'coo_demoted_board') return Promise.resolve({ data: board(), error: null });
    if (fn === 'funders_board_decide_level') return Promise.resolve({ data: { state: 'decided', level: args.p_level, label: 'COO queue' }, error: null });
    if (fn === 'funders_board_counter') return Promise.resolve({ data: COUNTER, error: null });
    if (fn === 'funders_board_counter_list')
      return Promise.resolve({ data: [{ event_id: 11, kind: 'rent_request', item_id: 'rr-9', short_id: 'rr-9', tag_label: 'Verified', title: 'Okello Tenant', place: 'Mukono', amount: 600_000, by_name: 'Agnes Namata', staff_ref: 'EMP-014', at: '2026-11-09T07:00:00Z' }], error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

describe('COO desk: Demoted from the funders board', () => {
  it('each awaiting row: photo, tag, title, place, UGX, reason, who demoted it, days waiting, status', async () => {
    wrap(<DemotedPanel board={false} />);
    const row = await screen.findByText('Achieng Grace').then((el) => el.closest('[data-demotion]') as HTMLElement);
    expect(rpcMock).toHaveBeenCalledWith('coo_demoted_board', { p_days: 30 });
    expect(within(row).getByRole('img').getAttribute('src')).toBe('https://example.test/p.jpg');
    expect(within(row).getByText('Verified')).toBeTruthy();
    expect(within(row).getByText('Kireka')).toBeTruthy();
    expect(within(row).getByText('UGX 1,250,000')).toBeTruthy();
    expect(within(row).getByText('Photos not good enough to show funders')).toBeTruthy();
    expect(row.textContent).toContain('Demoted by Agnes Namata · EMP-014 · COO');
    expect(row.textContent).toContain('1.5 days waiting');
    expect(row.textContent).toContain('Now: partner_ops_approved');
    expect(row.querySelector('[data-moved-by-system]')).toBeNull();
    const house = screen.getByText('Single room').closest('[data-demotion]') as HTMLElement;
    expect(within(house).getByText('Empty house')).toBeTruthy();
    expect(within(house).getByText('Landlord moved abroad last week')).toBeTruthy();
    expect(house.querySelector('[data-moved-by-system]')).not.toBeNull();
    expect(screen.getByText('2 waiting for a level · UGX 1,550,000')).toBeTruthy();
  });

  it('levels come from levels[kind] with hints; Apply calls funders_board_decide_level', async () => {
    wrap(<DemotedPanel board={false} />);
    const row = await screen.findByText('Achieng Grace').then((el) => el.closest('[data-demotion]') as HTMLElement);
    const select = within(row).getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a level…', 'Agent Ops', 'COO queue', 'Back on the funders board']);
    const house = screen.getByText('Single room').closest('[data-demotion]') as HTMLElement;
    expect([...(within(house).getByRole('combobox') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'parked', 'restore']);
    const apply = within(row).getByRole('button', { name: 'Apply' });
    expect(apply).toHaveProperty('disabled', true);
    fireEvent.change(select, { target: { value: 'coo' } });
    expect(within(row).getByText('Stays in your graded queue to push later')).toBeTruthy();
    fireEvent.change(within(row).getByPlaceholderText('Note (optional)'), { target: { value: 'Push next week' } });
    await act(async () => {
      fireEvent.click(apply);
    });
    expect(rpcMock).toHaveBeenCalledWith('funders_board_decide_level', { p_demotion_id: 'd1', p_level: 'coo', p_note: 'Push next week' });
  });

  it('hides the level controls when can_decide is false; decided list folds', async () => {
    rpcMock.mockImplementation((fn: string) => Promise.resolve({ data: fn === 'coo_demoted_board' ? board({ can_decide: false }) : null, error: null }));
    wrap(<DemotedPanel board={false} />);
    await screen.findByText('Achieng Grace');
    expect(document.querySelector('[data-level-controls]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    const fold = screen.getByRole('button', { name: /Decided \(30 days\)/ });
    expect(document.querySelector('[data-decided]')).toBeNull();
    fireEvent.click(fold);
    const decided = document.querySelector('[data-decided="d9"]') as HTMLElement;
    expect(decided.textContent).toContain('Parked off the board');
    expect(decided.textContent).toContain('by Agnes Namata · EMP-014');
  });

  it('shows a loading state, not zeros, and hides for a viewer the server refuses', async () => {
    let resolve!: (v: unknown) => void;
    rpcMock.mockImplementation(() => new Promise((r) => (resolve = r)));
    const a = wrap(<DemotedPanel board={false} />);
    expect(screen.getByLabelText('Loading demoted houses')).toBeTruthy();
    expect(a.container.textContent).not.toMatch(/\b0 waiting/);
    a.unmount();
    rpcMock.mockImplementation(() => Promise.resolve({ data: null, error: { code: '42501', message: 'COO desk only' } }));
    const b = wrap(<DemotedPanel board={false} />);
    await waitFor(() => expect(b.container.textContent).toBe(''));
  });
});

describe('COO graded queue: a demoted request waits for its level', () => {
  const row = (over: Partial<CooRow> = {}): CooRow => ({
    id: 'rr-1', req: 'rr-1', tenant: 'T', agent: 'A', agent_grade: 'A', landlord: 'L', landlord_verified: true, rent: 100, days_here: 1,
    ratings: null, grade: 'A', avg: 80, flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, ...over,
  });
  it('shows "Demoted: choose level above" and is never pushed', () => {
    const r = row({ demoted_awaiting: true });
    expect(cooChips(r).map((c) => c.text)).toContain('Demoted: choose level above');
    expect(isPushable(r)).toBe(false);
    expect(pushPlan([r, row({ id: 'rr-2', rank: 2 })], 10).rows.map((x) => x.id)).toEqual(['rr-2']);
  });
  it('the server hold FUNDERS_BOARD_DEMOTED counts too, without a second "On hold" chip', () => {
    const r = row({ waiting: { reason_code: 'FUNDERS_BOARD_DEMOTED', owner_kind: 'coo', until_at: '2026-12-09T00:00:00Z', expired: false, note: 'Demoted', rule_id: 'FB-LEVEL' } });
    const chips = cooChips(r).map((c) => c.text);
    expect(chips).toContain('Demoted: choose level above');
    expect(chips.some((t) => t.startsWith('On hold'))).toBe(false);
    expect(isPushable(r)).toBe(false);
  });
});

describe('CFO desk: Houses on the funders board', () => {
  it('figures with thousands separators and the breakdown', async () => {
    wrap(<FundersBoardCounterCard board={false} />);
    await screen.findByText('UGX 381,752');
    expect(screen.getAllByText('UGX 52,300,000').length).toBe(2); // the big figure and the "= Houses waiting" line
    expect(screen.getAllByText('137').length).toBe(2);
    const lines = [...document.querySelectorAll('ul[aria-label="How the number moved"] li')].map((li) => li.textContent);
    expect(lines[0]).toContain('Frozen 9 Nov 2026');
    expect(lines[0]).toContain('140');
    expect(lines[1]).toMatch(/\+COO pushes3UGX 1,800,000/);
    expect(lines[2]).toMatch(/\+Restored1UGX 300,000/);
    expect(lines[3]).toMatch(/−Demoted7UGX 2,800,000/);
    const side = [...document.querySelectorAll('ul[aria-label="Alongside"] li')].map((li) => li.textContent);
    expect(side[0]).toContain('Awaiting COO level');
    expect(side[1]).toMatch(/Verified live now41UGX 22,100,000/);
  });

  it('tapping pushed / restored / removed opens funders_board_counter_list(kind)', async () => {
    wrap(<FundersBoardCounterCard board={false} />);
    await screen.findByText('UGX 381,752');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^COO pushes/ }));
    });
    expect(rpcMock).toHaveBeenCalledWith('funders_board_counter_list', { p_kind: 'pushed' });
    const sheet = await screen.findByRole('dialog', { name: 'Added by COO pushes' });
    expect(await within(sheet).findByText('Okello Tenant')).toBeTruthy();
    expect(within(sheet).getByText('UGX 600,000')).toBeTruthy();
    fireEvent.click(within(sheet).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Demoted/ }));
    });
    expect(rpcMock).toHaveBeenCalledWith('funders_board_counter_list', { p_kind: 'removed' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Restored/ }));
    });
    expect(rpcMock).toHaveBeenCalledWith('funders_board_counter_list', { p_kind: 'restored' });
  });

  it('loading shows no false zeros', () => {
    rpcMock.mockImplementation(() => new Promise(() => {}));
    const r = wrap(<FundersBoardCounterCard board={false} />);
    expect(screen.getByLabelText('Loading the funders board counter')).toBeTruthy();
    expect(r.container.textContent).not.toMatch(/UGX 0|\b0\b/);
  });
});
