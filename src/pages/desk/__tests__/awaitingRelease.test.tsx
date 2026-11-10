import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));

import { AwaitingReleaseCard, awaitingLine, releaseTone, waitedText } from '../AwaitingRelease';
import { PushQueueCards } from '../PushQueueCards';

const RELEASED_BY = "Partner Ops approves the funder's commitment, then the money goes to the agent's landlord float";
const DATA = {
  count: 3,
  ugx: 2100000,
  oldest_hours: 30.4,
  released_by: RELEASED_BY,
  items: [
    { id: 'a', short_id: 'aaaa1111', tenant: 'Odenyo Elly', rent: 700000, funder: 'Grace Funder', picked_at: '2026-11-09T08:00:00Z', hours_waiting: 30.4, commitment_status: 'pending_approval' },
    { id: 'b', short_id: 'bbbb2222', tenant: 'Tina Nakato', rent: 800000, funder: 'Welile', picked_at: '2026-11-10T08:00:00Z', hours_waiting: 6.2, commitment_status: null },
    { id: 'c', short_id: 'cccc3333', tenant: 'Brian S', rent: 600000, funder: null, picked_at: '2026-11-10T12:00:00Z', hours_waiting: 2, commitment_status: null },
  ],
  as_of: '2026-11-10T14:00:00Z',
};

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  rpcMock.mockReset();
});

describe('Selected · awaiting release: the words and the colour', () => {
  it('"{count} selected · UGX {ugx} · awaiting release"', () => {
    expect(awaitingLine({ count: 3, ugx: 2100000 })).toBe('3 selected · UGX 2,100,000 · awaiting release');
  });
  it('amber past a day, red past three days', () => {
    expect(releaseTone(2)).toBe('ok');
    expect(releaseTone(24)).toBe('ok');
    expect(releaseTone(24.1)).toBe('warn');
    expect(releaseTone(72)).toBe('warn');
    expect(releaseTone(72.5)).toBe('bad');
    expect(releaseTone(null)).toBe('idle');
  });
  it('hours waiting read as hours, then days', () => {
    expect(waitedText(6.2)).toBe('6 h');
    expect(waitedText(30.4)).toBe('30 h');
    expect(waitedText(80)).toBe('3 d 8 h');
  });
});

describe('the card', () => {
  it('loads with a skeleton, never a zero', async () => {
    let answer!: (v: unknown) => void;
    rpcMock.mockReturnValue(new Promise((r) => (answer = r)));
    wrap(<AwaitingReleaseCard board={false} />);
    expect(screen.queryByText(/selected ·/)).toBeNull();
    expect(screen.queryByText(/\b0\b/)).toBeNull();
    answer({ data: DATA, error: null });
    expect(await screen.findByText('3 selected · UGX 2,100,000 · awaiting release')).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith('funders_selected_awaiting_release', { p_limit: 100 });
  });

  it('amber when the oldest waited over 24 h; the subline says who releases it; tap opens the list', async () => {
    rpcMock.mockResolvedValue({ data: DATA, error: null });
    wrap(<AwaitingReleaseCard board={false} />);
    const tile = (await screen.findByText('3 selected · UGX 2,100,000 · awaiting release')).closest('button') as HTMLElement;
    expect(tile.getAttribute('data-tone')).toBe('warn');
    expect(screen.getByText(RELEASED_BY)).toBeTruthy();

    fireEvent.click(tile);
    const sheet = screen.getByRole('dialog', { name: 'Selected · awaiting release' });
    const rows = within(sheet).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Odenyo Elly');
    expect(rows[0].textContent).toContain('UGX 700,000');
    expect(rows[0].textContent).toContain('Funder: Grace Funder');
    expect(rows[0].textContent).toContain('30 h');
    expect(rows[2].textContent).toContain('Funder: —');
  });

  it('red past 72 h', async () => {
    rpcMock.mockResolvedValue({ data: { ...DATA, oldest_hours: 80 }, error: null });
    wrap(<AwaitingReleaseCard board={false} />);
    const tile = (await screen.findByText(/3 selected/)).closest('button') as HTMLElement;
    expect(tile.getAttribute('data-tone')).toBe('bad');
  });

  it('nothing selected: "0 selected" only once the server has said so', async () => {
    rpcMock.mockResolvedValue({ data: { count: 0, ugx: 0, oldest_hours: null, released_by: RELEASED_BY, items: [] }, error: null });
    wrap(<AwaitingReleaseCard board={false} />);
    fireEvent.click((await screen.findByText('0 selected · UGX 0 · awaiting release')).closest('button') as HTMLElement);
    expect(screen.getByText('Nothing selected is waiting for release.')).toBeTruthy();
  });

  it('a refusal shows the server message, not a zero', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    wrap(<AwaitingReleaseCard board={false} />);
    // The hook retries once before it shows the error.
    expect((await screen.findByRole('alert', {}, { timeout: 5000 })).textContent).toBe('not authorized');
    expect(screen.queryByText(/selected ·/)).toBeNull();
  });
});

describe('placement: beside the funders board (COO desk and Command Centre share these cards)', () => {
  it('comes right after "Funders board"', async () => {
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'funders_selected_awaiting_release' ? { data: DATA, error: null } : { data: {}, error: null }),
    );
    wrap(<PushQueueCards board={false} enabled onCooDesk />);
    await waitFor(() => expect(document.querySelector('[data-awaiting-release]')).toBeTruthy());
    const titles = Array.from(document.querySelectorAll('section > h2')).map((h) => h.textContent);
    expect(titles.indexOf('Selected · awaiting release')).toBe(titles.indexOf('Funders board') + 1);
  });
});
